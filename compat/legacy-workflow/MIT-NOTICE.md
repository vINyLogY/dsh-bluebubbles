# Source provenance

The legacy host engine and worker bundle are source-ported from the published
MIT-licensed `@deepseek-ai/dsh-workflow-worker-thread@0.1.1-rc.2` package.
Original host source SHA256:
`70471246f6c6910ee2c4f6a06337e1ecce650b39e41d302c56d63bde7ce22971`.
Original worker bundle SHA256:
`5ff18c639abe3404de579b9571c2d45b29ff39e0e3b5f97d4dddc3dce405a3db`.
The legacy DSL, combinators, closed protocol and lifecycle logic retain that
provenance; the execution transport is changed to the public target Node PTC
runner. This is not the official worker-thread package or a runtime patch.

Copyright and permission notice from the upstream package must accompany this
port; publication is prohibited. The complete upstream MIT notice is retained
in `LICENSE.upstream`.
