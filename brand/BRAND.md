# Release-Harness Brand

## Identity

The formal product name is **Release-Harness**. Use that spelling in prose,
headings, page titles, package descriptions, and accessibility labels. The visual
wordmark is **release.harness** and may appear only as rendered logo artwork or a
deliberate visual lockup. It does not replace the package name
`@xibodev/release-harness` or the `release-harness` CLI command.

The mark is the **Locking Caliper Clamp**. Two opposed caliper jaws close around
a gold evidence point carrying a check. The mark represents a bounded gate with
a recorded result. It is not a generic approval badge and must not imply that a
person or an AI agent can override the evaluator.

Do not use the former `RH` text tile as the public mark.

## Mark Construction

The canonical mark uses the `0 0 100 100` coordinate system below. Standalone
mark and icon files use `viewBox="0 0 100 100"`; lockups and social artwork place
this unchanged geometry within their wider viewBoxes.

```text
Left jaw:  M38 20 C22 20 16 34 16 50 C16 66 22 80 38 80 L38 68 C28 68 26 58 26 50 C26 42 28 32 38 32 Z
Right jaw: M62 20 C78 20 84 34 84 50 C84 66 78 80 62 80 L62 68 C72 68 74 58 74 50 C74 42 72 32 62 32 Z
Center:    circle at 50,50 with radius 15
Check:     M43 50 L48 55 L57 44
```

The check has a `3.5` stroke width with round caps and joins. Do not stretch,
rotate, outline, rearrange, or redraw the elements. Keep at least one center-circle
radius of clear space around a standalone mark or lockup.

Use the mark at 24 CSS pixels or larger in interfaces. The supplied favicon is
the small-format exception. Use a lockup at 140 CSS pixels wide or larger; below
that size, use the mark with a separate accessible product label.

## Color

| Token | Value | Use |
|---|---|---|
| Gunmetal | `#14171E` | Primary ink, dark tile, check |
| Caliper Steel | `#94A3B8` | Jaws on dark surfaces |
| Safety Gold | `#EAB308` | Evidence point and identity accent |
| Dark Steel | `#475569` | Jaws on light surfaces |
| Dark Gold | `#A16207` | Gold text and compact controls on light surfaces |
| White | `#FFFFFF` | Inverse wordmark and one-color artwork |

Safety Gold is the identity accent. Use Dark Gold when small gold text or a
control needs stronger contrast on a light surface. Use Caliper Steel on dark
surfaces and Dark Steel on light surfaces.

Identity colors do not encode gate outcomes. Preserve the separate semantic
colors for `PASS`, `ASSERTION VIOLATED`, `UNPROVEN`, usage or binding errors, and
harness or evidence-integrity failures. Never recolor an outcome to brand gold
merely to make it feel branded.

## Logo Variants

- `mark.svg`: primary mark on its Gunmetal tile.
- `mark-inverse.svg`: transparent mark for dark backgrounds.
- `lockup.svg`: light-background mark and `release.harness` wordmark.
- `lockup-inverse.svg`: dark-background mark and wordmark.
- `wordmark.svg` and `wordmark-inverse.svg`: wordmark-only variants.
- `mono-black.svg` and `mono-white.svg`: one-color lockups for constrained
  reproduction. The check is knocked out of the single ink color.

Use inverse artwork only on a sufficiently dark, solid background. Do not add
effects, gradients, drop shadows, or alternate container shapes to logo files.
The square icon family uses the Gunmetal tile treatment.

## Typography

The wordmark uses a sturdy system monospace stack. It remains text in the SVG so
the files stay small and portable:

```css
ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace
```

Product interfaces may use their established sans-serif and monospace stacks.
Do not download or bundle a font solely for the logo.

## Voice And Trust

Write with deterministic, evidence-led language:

- State what policy required, what the CLI observed, and what verdict resulted.
- Distinguish a declared gate from deployment approval or production readiness.
- Describe trust boundaries and missing evidence directly.
- Say when a capability is planned or unavailable.
- Keep instructions operational and claims verifiable.

Preferred constructions include:

- "The deterministic evaluator decides from declared policy and recorded
  evidence."
- "AI assistance can prepare contracts and investigate failures. It does not
  decide the gate."
- "A PASS covers the declared requirements; it is not deployment approval."

Do not say that evidence alone, agent advice, confidence, risk scoring, or verbal
approval determines a verdict. Do not use hype to blur a security, evidence, or
execution boundary.

## Accessibility

When visible product text already names Release-Harness, give the adjacent mark
an empty `alt` value. When a linked mark has no visible formal name, label the
link `Release-Harness home`; do not make assistive technology infer the product
from the visual wordmark or image filename. Keep focus indicators and text
contrast independent from the logo palette.

SVG titles and descriptions support standalone asset inspection. They do not
replace appropriate HTML alternative text in the consuming interface.
