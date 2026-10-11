#!/bin/sh
# Test fixture (read-only): fails with an internal error message on stderr.
echo "internal detail: token=fixture-not-a-secret" >&2
exit 3
