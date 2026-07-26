"""Condition-normalised baselines: what a healthy asset does under these conditions.

A static threshold on a raw signal cannot distinguish "unusual conditions" from
"unhealthy equipment", so it fires on both. The baselines in this package learn
expected performance as a function of the operating conditions, and everything
downstream consumes the leftover.
"""
