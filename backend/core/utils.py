"""
ArticulAIT — Core Utilities
Helper functions for natural alphanumeric sorting and path handling.
"""
import re

def natural_sort_key(s: str):
    """
    Key function for natural alphanumeric sorting.
    Ensures '1.jpg', '2.jpg', ..., '10.jpg' are sorted in numerical sequence
    instead of lexicographical ('1.jpg', '10.jpg', '2.jpg').
    """
    if not isinstance(s, str):
        s = str(s)
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', s)]
