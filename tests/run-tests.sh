#!/bin/sh
# Self-contained fixtures only: no installed game, Steam client, or device needed.
set -eu

test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test_node=${ALABASTER_TEST_NODE:-node}

for test_name in \
    setup.test.cjs \
    save-transfer.test.cjs \
    steam-cloud.test.cjs \
    cloud-sync.test.cjs \
    local-copy-cloud-regression.test.cjs \
    steam-shortcut.test.cjs \
    controller-emulation.test.cjs \
    uninstall.test.cjs
do
    printf '\nRunning %s\n' "$test_name"
    "$test_node" "$test_dir/$test_name"
done

printf '\nRunning install-script.sh\n'
bash "$test_dir/install-script.sh"
