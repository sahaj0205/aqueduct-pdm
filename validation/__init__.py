"""Accuracy measurement against ground-truth labels.

This is the only package in the project permitted to open ADMIN_DATABASE_URL and
read schema groundtruth. Everything that detects, scores, baselines, predicts or
diagnoses connects as app_rw, which the database physically denies access to the
answer key. That asymmetry is the reason a number produced here means something:
no layer under analytics/ could have seen the label it is being scored against,
because the credential it holds cannot read it.
"""
