"""The analytics layers: quality, rules, baselines, health, RUL and diagnosis.

Named `analytics` rather than `platform`, which is what PROJECT_CONTEXT.md
originally called it. `platform` is a Python standard library module, so a
top-level package of that name shadows it, and importing pandas -- which calls
platform.python_implementation() at import time -- fails outright. Task prompts
that say `platform/...` mean this package.
"""
