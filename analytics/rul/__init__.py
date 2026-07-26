"""Remaining useful life: how long until this mode reaches its failure threshold.

The health index says where a machine is. This package says where it is going,
and how sure it is. The order is deliberate and cannot be shortcut: a trend is
only ever fitted to a stretch of data that a changepoint detector has already
confirmed contains a change, because a slope fitted to noise still produces a
confident date and that date is worse than no answer at all.
"""
