/**
 * `run` -- exercise a proposition, in a mode chosen before anything happens.
 *
 * The ordering in this file is the point, so it is worth stating plainly: the
 * gate runs first, and nothing that touches the world happens above it. No
 * directory is created, no process is started, no evidence is opened until the
 * mode has been decided.
 *
 * The previous architecture read the config that determined whether a run could
 * certify AFTER materializing source, launching Chromium and sealing evidence.
 * It performed the work of certification and only then asked whether it had
 * been entitled to. A gate that opens after the horse has bolted is decoration,
 * so this one is placed where it cannot be.
 *
 * To make that checkable from outside rather than merely true by reading, every
 * side effect is announced to a trace the caller can inspect. A test can then
 * assert that a refused run produced no side-effect entries at all, which is
 * evidence rather than an argument about control flow.
 */

import fs from 'node:fs';
import path from 'node:path';
import { paths, readJson, writeJson, resolveAccepted, isInstalled } from './layout.js';
import { EXIT, exitCodeForCause } from './exit-codes.js';
import { decideMode, resolveBindings } from '../bindings.js';
import { attributeFailure, MODE, CAUSE } from '../attribution.js';
import { buildRunManifest } from '../run-manifest.js';
import { EvidenceSealer } from '../sealer.js';
import { executeAssertion } from './execute.js';

/**
 * The side-effect trace.
 *
 * Written to the run directory when a run produces one, and returned in-process
 * so a test can read it even when the run was refused before creating anything.
 */
function createTrace() {
  const entries = [];
  return {
    entries,
    mark(kind, detail) {
      entries.push({ kind, detail, at: new Date().toISOString() });
    },
  };
}

function newRunId() {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  return `run-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function cmdRun(ctx) {
  const { cwd, out, args, version } = ctx;
  const trace = createTrace();
  ctx.trace = trace; // exposed for in-process tests

  if (!isInstalled(cwd)) {
    out.error('release-harness is not installed here. Run `release-harness init` first.');
    return EXIT.USAGE_OR_CONTRACT;
  }

  const p = paths(cwd);

  // -------------------------------------------------------------------------
  // Everything below, up to the gate, only READS. Nothing is created.
  // -------------------------------------------------------------------------

  const exploratory = args.flags.exploratory === true || args.flags.exploratory === 'true';
  const draftName = typeof args.flags.draft === 'string' ? args.flags.draft : null;

  // Exploratory mode is requested, never inferred. A run does not become
  // exploratory because something was dirty or incomplete -- that would make
  // the weakest outcome the automatic one, and nobody would notice the slide.
  if (draftName && !exploratory) {
    out.error(`Running a draft is not certification. Pass --exploratory to say so explicitly.`);
    out.error('An unaccepted proposition has not been agreed by anyone, so nothing it');
    out.error('reports can be authoritative.');
    return EXIT.USAGE_OR_CONTRACT;
  }

  let contract = null;
  let proposition = null;

  if (draftName) {
    const draft = readJson(p.draft(draftName));
    if (!draft.found) {
      out.error(`No draft named "${draftName}".`);
      return EXIT.USAGE_OR_CONTRACT;
    }
    if (draft.error) {
      out.error(draft.error);
      return EXIT.USAGE_OR_CONTRACT;
    }
    proposition = draft.value.proposition;
  } else {
    const ref = typeof args.flags.contract === 'string' ? args.flags.contract : undefined;
    const resolved = resolveAccepted(cwd, ref);
    if (!resolved.ok) {
      out.error(resolved.reason);
      if (!exploratory) {
        out.error('');
        out.error('Accept a draft first, or run one with --draft <name> --exploratory.');
      }
      return EXIT.USAGE_OR_CONTRACT;
    }
    const loaded = readJson(p.contract(resolved.digest));
    if (loaded.error) {
      out.error(loaded.error);
      return EXIT.USAGE_OR_CONTRACT;
    }
    contract = loaded.value;
    proposition = contract;
  }

  const bindingName = typeof args.flags.binding === 'string' ? args.flags.binding : null;
  if (!bindingName) {
    out.error('Usage: release-harness run --binding <name> [--contract <digest>|--draft <name> --exploratory]');
    return EXIT.USAGE_OR_CONTRACT;
  }
  const bindingDoc = readJson(p.binding(bindingName));
  if (!bindingDoc.found) {
    out.error(`No binding named "${bindingName}". Create one with \`release-harness bind\`.`);
    return EXIT.USAGE_OR_CONTRACT;
  }
  if (bindingDoc.error) {
    out.error(bindingDoc.error);
    return EXIT.USAGE_OR_CONTRACT;
  }
  const bindings = bindingDoc.value;

  // Normative references are resolved against what is accepted here and now. A
  // reference that has moved means this contract was accepted against a
  // proposition that no longer exists.
  const resolvedRefs = {};
  for (const req of contract?.requires ?? []) {
    const refFile = p.contract(req.ref);
    const referenced = readJson(refFile);
    if (referenced.found && referenced.value?.digest) resolvedRefs[req.ref] = referenced.value.digest;
    else if (fs.existsSync(p.contract(req.digest))) resolvedRefs[req.ref] = req.digest;
  }

  // -------------------------------------------------------------------------
  // THE GATE. Mode is fixed here, from data alone.
  // -------------------------------------------------------------------------
  const decision = exploratory
    ? { mode: MODE.EXPLORATORY, eligible: false, reasons: [{ code: 'EXPLORATORY_REQUESTED', detail: 'The operator asked for an exploratory run.' }] }
    : decideMode(contract, bindings, { resolvedRefs });

  out.data('mode', decision.mode);
  out.data('eligible', decision.eligible);

  // A certifying run that is not eligible does not run at all. Falling back to
  // an exploratory run would silently give the operator something other than
  // what they asked for, and they asked for a certificate.
  if (!exploratory && !decision.eligible) {
    out.error('This run cannot certify, so it was not started:');
    for (const r of decision.reasons) out.error(`  [${r.code}] ${r.detail}`);
    out.error('');
    out.error('Nothing was executed. Fix the above, or run --exploratory to try anyway.');
    out.data('reasons', decision.reasons);
    out.data('side_effects', trace.entries);
    return EXIT.USAGE_OR_CONTRACT;
  }

  const { resolved: targets, unresolved } = resolveBindings(proposition, bindings);
  if (unresolved.length > 0 && !exploratory) {
    out.error(`Unbound target${unresolved.length === 1 ? '' : 's'}: ${unresolved.join(', ')}`);
    out.data('side_effects', trace.entries);
    return EXIT.USAGE_OR_CONTRACT;
  }

  // -------------------------------------------------------------------------
  // Past the gate. From here on, side effects are permitted and announced.
  // -------------------------------------------------------------------------

  const runId = newRunId();
  const runDir = p.run(runId);
  const evidenceDir = path.join(runDir, 'evidence');

  trace.mark('mkdir', runDir);
  fs.mkdirSync(evidenceDir, { recursive: true });

  trace.mark('evidence_open', evidenceDir);
  const sealer = new EvidenceSealer(evidenceDir, runId);

  const startedAt = new Date().toISOString();
  const timeoutMs = Number(readJson(p.config).value?.run_timeout_ms) || 600000;

  const observations = [];
  for (const assertion of proposition.assertions ?? []) {
    trace.mark('probe', `${assertion.id} (${assertion.kind} -> ${assertion.target})`);

    const result = await executeAssertion(assertion, targets, {
      timeoutMs: Math.min(timeoutMs, 30000),
      cwd,
    });

    sealer.writeEvidence(
      `probes/${assertion.id}.json`,
      JSON.stringify({ assertion: assertion.id, ...result }, null, 2) + '\n'
    );
    observations.push(result);
  }

  trace.mark('seal', evidenceDir);
  const sealed = sealer.sealEvidence();

  // -------------------------------------------------------------------------
  // Adjudicate. Every attribution goes through the one shared path.
  // -------------------------------------------------------------------------

  const acceptedIds = new Set((contract?.assertions ?? []).map((a) => a.id));
  const adjudicated = observations.map((o) => {
    if (o.passed) return { id: o.id, status: 'PASS', observed: o.observed };

    const verdict = attributeFailure(
      {
        reported: o.cause,
        // Product attribution needs an accepted assertion to have been
        // violated. An exploratory run has none by definition.
        hasAcceptedAssertion: acceptedIds.has(o.id),
        // And it needs an observation of the subject's behaviour. A binding
        // that answered nothing produced no such observation.
        hasSupportingEvidence: o.cause === CAUSE.PRODUCT,
      },
      decision.mode
    );

    return {
      id: o.id,
      status: 'FAIL',
      cause: verdict.cause,
      authoritative: verdict.authoritative,
      rationale: verdict.rationale,
      observed: o.observed,
    };
  });

  const failures = adjudicated.filter((a) => a.status === 'FAIL');
  const certifying = decision.mode === MODE.CERTIFYING;

  let status;
  if (!certifying) {
    // An exploratory run never passes. Everything it tried may have worked, and
    // that is worth knowing -- it is just not a certificate.
    status = failures.length > 0 ? 'FAIL' : 'UNPROVEN';
  } else {
    status = failures.length > 0 ? 'FAIL' : 'PASS';
  }

  const verdict = {
    schema_version: '1.0.0',
    run_id: runId,
    status,
    certifying,
    contract_digest: contract?.digest ?? null,
    assertions: adjudicated,
    summary: {
      total: adjudicated.length,
      passed: adjudicated.length - failures.length,
      failed: failures.length,
    },
  };

  const manifest = buildRunManifest({
    runId,
    contract,
    bindings,
    sources: { cwd: path.resolve(cwd) },
    evidenceManifestSha256: sealed.manifestSha256,
    verdict,
    mode: decision.mode,
    ineligibleReasons: decision.eligible ? [] : decision.reasons,
    startedAt,
    completedAt: new Date().toISOString(),
  });
  manifest.harness_version = version;

  trace.mark('write_manifest', path.join(runDir, 'manifest.json'));
  writeJson(path.join(runDir, 'manifest.json'), manifest);
  writeJson(path.join(runDir, 'verdict.json'), verdict);
  writeJson(path.join(runDir, 'side-effects.json'), { run_id: runId, entries: trace.entries });

  // -------------------------------------------------------------------------
  // Render.
  // -------------------------------------------------------------------------

  out.data('run_id', runId);
  out.data('verdict', verdict);
  out.data('side_effects', trace.entries);

  out.heading(certifying ? `Certifying run ${runId}` : `Exploratory run ${runId} -- NOT certifying`);

  if (!certifying) {
    out.info('This run cannot certify anything:');
    for (const r of decision.reasons) out.detail(`[${r.code}] ${r.detail}`);
    out.blank();
  }

  for (const a of adjudicated) {
    if (a.status === 'PASS') {
      out.info(`ok      ${a.id}  ${a.observed}`);
    } else {
      const label = a.authoritative ? a.cause : `${a.cause} (not authoritative)`;
      out.info(`FAILED  ${a.id}  ${a.observed}`);
      out.detail(`cause: ${label}`);
      out.detail(a.rationale);
    }
  }

  out.blank();
  out.info(`${verdict.summary.passed}/${verdict.summary.total} passed. Status: ${status}.`);
  out.detail(`${runDir}`);
  out.blank();
  out.info(`  release-harness verify ${runId}`);

  // Exit code comes from the most serious cause present, so automation can
  // branch without parsing prose.
  if (!certifying) return EXIT.UNPROVEN;
  if (failures.length === 0) return EXIT.OK;

  const worst = failures
    .map((f) => exitCodeForCause(f.cause))
    .sort((a, b) => (a === EXIT.ASSERTION_FAILED ? -1 : b === EXIT.ASSERTION_FAILED ? 1 : a - b))[0];
  return worst;
}
