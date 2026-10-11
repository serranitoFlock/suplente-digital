#!/bin/sh
# Test fixture (read-only): shows whether two test variables reached the script.
printf 'allowed=%s\n' "${SUPLENTE_TEST_ALLOWED:-unset}"
printf 'secret=%s\n' "${SUPLENTE_TEST_SECRET:-unset}"
