# QuickJS-NG

- Version: 0.17.0.
- Upstream: https://github.com/quickjs-ng/quickjs/tree/v0.17.0
- Source archive: https://github.com/quickjs-ng/quickjs/archive/refs/tags/v0.17.0.tar.gz
- SHA256: `559bc4c420475e55c7ab4510adbc562f55d7524d75e8e89d79ce4bb02f5687d9`.
- License: MIT, reproduced in `LICENSE` and included in the APK assets.

`scripts/prepare-native.py` obtains and verifies the archive and compiled source/header cache. Sources remain under the ignored `.local/vendor/quickjs` directory. The application compiles only the engine, regular-expression, Unicode, and numeric-conversion sources. The upstream `std`/`os` modules and command-line tools are not linked.

