def test_intentional_failure_for_smoke_harness():
    """DELIBERATE FAILING TEST for unit-integration-test smoke.
    The runner must report this as a failure (NOT crash) and emit
    a fix-plan item per failure.
    """
    assert 1 == 2, "deliberate fail — do not 'fix' this test"
