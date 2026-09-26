# Pinned runtime tests

The two fixture manifests and lockfiles keep the deployed DSH 0.1.1 cohort
separate from DSH 0.1.7-rc.2. They do not replace the plugin's development
dependencies or upgrade an installed server.

The legacy fixture pins CLI 0.1.1-rc.1, the 0.1.1-rc.2 agent and persistence
contracts, and the deployed shell/Cordis interfaces. Install it with
`npm ci --ignore-scripts --legacy-peer-deps`; required peer contracts are
explicit dependencies. The next fixture pins CLI 0.1.7-rc.2 and its runtime
contracts. Its lock uses normal peer resolution; install it with
`npm ci --ignore-scripts`.

CI installs one fixture into a fresh directory and links only its
`node_modules` into the real source checkout. The source files are not
symlinked: their ESM imports and TypeScript resolution must use the selected
cohort. The runtime test must verify resolved package paths and versions
against `DSH_RUNTIME_NODE_MODULES` and `DSH_RUNTIME_COHORT`.

The tests use a temporary home, synthetic bindings and session records, a
mock model provider, and a loopback BlueBubbles replacement. They must never
read the real DSH home or send real messages. Installing with lifecycle
scripts disabled requires the tested local shell/filesystem components to
work from the published artifacts; this does not qualify unused optional
voice or other native components, or a complete production deployment.
