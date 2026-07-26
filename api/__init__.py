"""The read-only HTTP surface over everything the analytics layers produced.

Every endpoint here serves numbers that were computed and committed by a script
somewhere else. Nothing in this package detects, fits, predicts or diagnoses, and
that is a deliberate boundary rather than an accident of layering: building one
advisory means running the isolation sweep, the rule engine and the health replay
over a multi-month window, which is minutes of work. An HTTP request cannot wait
for it and an operator refreshing a dashboard certainly cannot.

So the API is a reader. `make advisories` writes the queue; the API serves it.
"""
