"""Deciding what is actually broken: a sensor, the equipment, or the control.

Every layer above this one detects that something is wrong and how fast it is
getting worse. None of them can say whether the machine is failing or whether a
thermometer is lying about it, and those two call for opposite actions -- one
sends a technician to the plant room, the other sends one with a screwdriver and
a reference probe. Getting it backwards wastes the visit either way.

The discrimination rests on redundancy. If several independent relations all
involve the same measurement, a bias on that measurement makes a specific,
checkable prediction about all of them at once, and either they agree or they do
not.
"""
