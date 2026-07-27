"""The answer key, served as its own process on its own credential.

WHY THIS IS NOT AN ENDPOINT IN api/. The claim this project rests on is that no
detector here can have seen the label it is scored against, and until now that was
enforced by there being exactly one module in the repository able to open the
credential that reads schema groundtruth. A reveal screen needs to show both sides of
that line on one dashboard, and the tempting way to build it -- one more route on the
existing API -- would mean the process serving detections also holds the answer key.
The claim would then rest on nobody adding the wrong import.

So the reveal is a second application, on a second port, connecting as the admin role.
api/ still connects as app_rw, which has no privilege of any kind on that schema, and
still cannot serve a label if somebody adds an endpoint that asks for one. What
changes is the WORDING of the claim, and README.md and ARCHITECTURE.md are changed to
match: not "the answer key is unreachable from the running system" but "the detection
path connects as a role with no grant on it, and the one process that can read it
computes nothing".

Nothing in this package detects, scores, predicts or diagnoses. It reads labels, and
it compares a faulted run against its fault-free twin. If that ever stops being true,
the separation this project claims has been broken.
"""
