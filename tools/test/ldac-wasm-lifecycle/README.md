# ldac_wasm lifecycle fault-injection harness

Bounded native validation for `tools/ldac_wasm.c` construction/teardown
cleanup. It compiles the REAL glue (no source-text mirroring) against the
ABI stand-in headers in this directory (`ldacBT.h`, `ldacdec.h` name-mirror
the pinned libldac 2.00.02 / libldacdec 7f3bd6cc headers; the real artifact
identity stays owned by `tools/build_codec_wasm.sh`) and links stub codec
implementations. Allocation accounting and fault injection happen through
GNU/LLVM linker `--wrap` of `malloc`/`calloc`/`free`, so the glue is not
modified. All allocation pages come from an anonymous mapping pinned at a
low fixed address (`0x08000000`), emulating the WASM linear-memory
constraint that makes the glue's `int32_t` session handles valid; a native
malloc address above 2^31 would otherwise corrupt those handles in any
harness. There are no external dependencies beyond a host C compiler.

Covered (finding P2 at lines 133-140, baseline 9cf30ab — both leaks of the
8192-byte pending buffer on `ldacBT_get_handle` and
`ldacBT_init_handle_encode` failure, plus symmetric construction-failure,
scratch-allocation and destructor coverage):

- `ldac_wasm_encoder_new`: success (handle/init/meta counts, one padded
  stereo block, frame serve/copy, flush, exact-byte stub frame) and every
  failure path (handle acquire, init, struct/packet/pending allocations).
- `ldac_wasm_decoder_new`/`decode_block`/free: valid frame, corrupt-frame
  refusals, scratch-allocation failure, init failure, teardown.

Build/run (from the repository root, output stays out of the build tree):
The `native-codecs` CI job runs the same compile and execution steps.

```sh
mkdir -p /tmp/opencode/ldac-wasm-lifecycle
cc -std=c11 -Wall -Wextra -Wno-unused-parameter -Werror \
    -Itools/test/ldac-wasm-lifecycle \
    tools/test/ldac-wasm-lifecycle/lifecycle_test.c tools/ldac_wasm.c \
    -Wl,--wrap=malloc,--wrap=calloc,--wrap=free \
    -o /tmp/opencode/ldac-wasm-lifecycle/lifecycle_test
/tmp/opencode/ldac-wasm-lifecycle/lifecycle_test
```

Exit 0 with only `ok:` lines means every covered path balances its
allocations (bytes and count). With the pre-fix leak lines restored, exactly
the two pending-buffer leak path checks fail — recorded as the negative
control for this harness during implementation. The harness is
implementation-scoped validation; it does not replace the pinned-codec WASM
build, byte parity, or the TS/regression suites (parent integration owns
those).
