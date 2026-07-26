"""Turning findings into work somebody can be dispatched to do.

Every layer below this one produces a number: a residual, a health score, a
prediction interval, a fault class. None of them is an instruction. A maintenance
team cannot act on "the condenser heat-rejection residual is 0.49 K" -- they act
on "brush the condenser tubes, eight hours, one chiller technician, and here is
what it costs to keep putting it off".

This layer is where the numbers become that, and where the ranking happens. It is
also the last chance to be honest: an advisory that hides which numbers it rests
on, or that pads a prediction with a made-up confidence band, is worse than no
advisory, because it will be believed.
"""
