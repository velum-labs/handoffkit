"""hyperkit core: SUT-agnostic orchestration.

This subpackage must not import any system-under-test implementation
(e.g. ``fusionkit_*``). The boundary is enforced by
``tests/test_import_boundary.py``. Everything the core needs from a SUT,
benchmark, grader, or compute backend arrives through the Protocols in
``hyperkit.core.contracts`` and the plugin registry in
``hyperkit.core.registry``.
"""
