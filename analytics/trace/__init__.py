"""Recording what the pipeline did, as opposed to what it concluded.

Nothing in this package makes a decision. It calls the layers that do, counts what
went in and what came out of each, and records why the difference. Kept separate from
those layers on purpose: instrumenting eight modules to report on themselves would
mean eight places to keep in step, and the numbers would then be whatever each layer
chose to say about itself rather than what an outside observer measured.
"""
