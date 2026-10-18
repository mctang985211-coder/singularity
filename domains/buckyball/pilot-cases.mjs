// Authored pilot defects, not claims about historical upstream bugs.
const headers = '#include <stdint.h>\n#include <params.h>\n#include <bbhw/isa/isa.h>\n#include <dma.h>\n'
const dma = `${headers}
void bb_pilot_kernel(const int8_t *input, int8_t *output,
                     unsigned rows, unsigned input_stride, unsigned output_stride) {
  bb_mem_alloc(0, 1, 1);
  bb_dma_fence();
  bb_mvin((uintptr_t)input, 0, rows, input_stride);
  bb_mvout((uintptr_t)output, 0, rows, output_stride);
  bb_fence();
  bb_mem_release(0);
}
`
const relu = `${headers}#include <isa/relu.h>
#if BANK_WIDTH != 128 || BANK_LINES % 64 != 0
#error "pilot ReLU requires 128-bit banks and depth divisible by 64"
#endif
void bb_pilot_kernel(const int32_t *input, int32_t *output) {
  static int32_t staging[256] __attribute__((aligned(128)));
  for (unsigned i = 0; i < 256; ++i) staging[i] = input[i];
  bb_mem_alloc(0, 1, 1);
  bb_dma_fence();
  bb_mvin((uintptr_t)staging, 0, 64, 1);
  bb_relu(0, 0, 64, 64);
  bb_mvout((uintptr_t)output, 0, 64, 1);
  bb_fence();
  bb_mem_release(0);
}
`
const gemminiTranspose = `${headers}#include <isa/gemmini.h>
void bb_pilot_kernel(const int8_t *a, const int8_t *b, int32_t *output) {
  static int8_t zero[256] __attribute__((aligned(128)));
  bb_mem_alloc(0, 1, 1);
  bb_mem_alloc(1, 1, 1);
  bb_mem_alloc(2, 1, 4);
  bb_mem_alloc(3, 1, 1);
  bb_dma_fence();
  bb_mvin((uintptr_t)a, 0, 16, 1);
  bb_mvin((uintptr_t)b, 1, 16, 1);
  bb_mvin((uintptr_t)zero, 3, 16, 1);
  bb_gemmini_config(0, 0, 1, 0, 0);
  bb_gemmini_preload(3, 2, 16, 0, 0);
  bb_gemmini_compute_preloaded(0, 1, 2, 16, 0, 0, 0);
  bb_mvout((uintptr_t)output, 2, 16, 1);
  bb_fence();
  for (unsigned bank = 0; bank < 4; ++bank) bb_mem_release(bank);
}
`
const gemminiAccumulate = `${headers}#include <isa/gemmini.h>
void bb_pilot_kernel(const int8_t *a, const int8_t *b,
                     const int32_t *initial, int32_t *output) {
  bb_mem_alloc(0, 1, 1);
  bb_mem_alloc(1, 1, 1);
  bb_mem_alloc(3, 1, 4);
  bb_dma_fence();
  bb_mvin((uintptr_t)a, 0, 16, 1);
  bb_mvin((uintptr_t)b, 1, 16, 1);
  bb_mvin((uintptr_t)initial, 3, 16, 1);
  bb_gemmini_config(1, 0, 0, 0, 0);
  bb_gemmini_compute_accumulated(0, 1, 3, 16, 0, 0, 0);
  bb_mvout((uintptr_t)output, 3, 16, 1);
  bb_fence();
  bb_mem_release(0);
  bb_mem_release(1);
  bb_mem_release(3);
}
`

export const cases = [
  { id: 'dma-output-stride', family: 'dma-layout', split: 'evolve', kind: 'dma',
    lineage: 'bb-tests/workloads/src/CTest/base/mvin_mvout_stride_test.c', rootCause: 'destination-stride-confused-with-source',
    goal: 'Copy every selected DMA bank row to the requested destination stride, preserving all gap bytes.',
    good: dma, bad: dma.replace('0, rows, output_stride)', '0, rows, input_stride)') },
  { id: 'dma-last-row', family: 'dma-layout', split: 'evolve', kind: 'dma',
    lineage: 'bb-tests/workloads/src/CTest/base/mvin_mvout_test.c', rootCause: 'last-loaded-row-omitted',
    goal: 'Load and return every requested DMA row, including the final row, without changing destination gaps.',
    good: dma, bad: dma.replace('input, 0, rows,', 'input, 0, rows - 1,') },
  { id: 'relu-signed-staging', family: 'relu-boundaries', split: 'validation', kind: 'relu',
    lineage: 'examples/balls/relu/workloads/ctests/relu_i32_16x16_test.c', rootCause: 'signed-input-narrowed-before-activation',
    goal: 'Apply the ReLU ISA to all 256 signed int32 values, preserving every nonnegative value without narrowing.',
    good: relu, bad: relu.replace('staging[i] = input[i]', 'staging[i] = (uint8_t)input[i]') },
  { id: 'relu-complete-segment', family: 'relu-boundaries', split: 'validation', kind: 'relu',
    lineage: 'examples/balls/relu/workloads/ctests/relu_i32_16x16_test.c', rootCause: 'only-half-of-each-row-segment-activated',
    goal: 'Apply the ReLU ISA to the entire 64-line segment rather than leaving the latter half unprocessed.',
    good: relu, bad: relu.replace('bb_relu(0, 0, 64, 64)', 'bb_relu(0, 0, 32, 64)') },
  { id: 'gemmini-transpose-a', family: 'gemmini-composition', split: 'heldout', kind: 'transpose',
    lineage: 'examples/balls/gemmini/workloads/ctests/gemmini_os_risc_atranspose_test.c', rootCause: 'transpose-configuration-bit-omitted',
    goal: 'Use the Gemmini ISA to compute A-transpose times B for 16x16 signed int8 inputs and int32 output.',
    good: gemminiTranspose, bad: gemminiTranspose.replace('bb_gemmini_config(0, 0, 1, 0, 0)', 'bb_gemmini_config(0, 0, 0, 0, 0)') },
  { id: 'gemmini-preserve-accumulator', family: 'gemmini-composition', split: 'heldout', kind: 'accumulate',
    lineage: 'examples/balls/gemmini/workloads/ctests/gemmini_accumulated_16x16_test.c', rootCause: 'initial-accumulator-not-loaded',
    goal: 'Use the Gemmini accumulated-compute ISA to return initial plus A times B, preserving nonzero int32 initial values.',
    good: gemminiAccumulate, bad: gemminiAccumulate.replace('bb_mvin((uintptr_t)initial, 3, 16, 1);',
      'static int32_t zero[256] __attribute__((aligned(128)));\n  bb_mvin((uintptr_t)zero, 3, 16, 1);') },
].map(c => ({ ...c, target: `bb-tests/workloads/src/CTest/pilot/${c.id}.c`,
  sourceKind: 'explicitly-labelled-synthetic-defect', operatorModuleLineage: c.family }))

// The independent scalar program is compiled for the host. It never links candidate code.
// The RISC-V harness supplies inputs and prints actual outputs; it contains no expected answers.
export function programFor(c, reference, rowBytes) {
  const common = '#include <stdint.h>\n#include <stdio.h>\n#include <string.h>\n#ifndef BB_PILOT_SEED\n#define BB_PILOT_SEED 1\n#endif\n'
  if (c.kind === 'dma') return `${common}
#define ROW_BYTES ${rowBytes}
${reference ? '' : 'void bb_pilot_kernel(const int8_t *, int8_t *, unsigned, unsigned, unsigned);'}
int main(void) {
  unsigned seed = BB_PILOT_SEED;
  enum { ROWS = 4, INPUT_STRIDE = 3, OUTPUT_STRIDE = 5, N = ROWS * OUTPUT_STRIDE * ROW_BYTES };
  static int8_t input[ROWS * INPUT_STRIDE * ROW_BYTES] __attribute__((aligned(128)));
  static int8_t output[N] __attribute__((aligned(128)));
  for (unsigned i = 0; i < sizeof(input); ++i) input[i] = (int8_t)((i * 13 + seed * 7) % 251 - 125);
  memset(output, 0x5a, sizeof(output));
  ${reference ? 'for (unsigned r = 0; r < ROWS; ++r)\n    for (unsigned b = 0; b < ROW_BYTES; ++b)\n      output[(r * OUTPUT_STRIDE) * ROW_BYTES + b] = input[(r * INPUT_STRIDE) * ROW_BYTES + b];'
    : 'bb_pilot_kernel(input, output, ROWS, INPUT_STRIDE, OUTPUT_STRIDE);'}
  puts("BB_PILOT_RESULT");
  for (unsigned i = 0; i < N; ++i) printf("%d\\n", output[i]);
  puts("BB_PILOT_END");
  return 0;
}
`
  if (c.kind === 'relu') return `${common}
${reference ? '' : 'void bb_pilot_kernel(const int32_t *, int32_t *);'}
int main(void) {
  unsigned seed = BB_PILOT_SEED;
  static int32_t input[256] __attribute__((aligned(128)));
  static int32_t output[256] __attribute__((aligned(128)));
  for (unsigned i = 0; i < 256; ++i) input[i] = (int32_t)((i * 97 + seed * 19) % 8191) - 4095;
  memset(output, 0x5a, sizeof(output));
  ${reference ? 'for (unsigned i = 0; i < 256; ++i) output[i] = input[i] < 0 ? 0 : input[i];' : 'bb_pilot_kernel(input, output);'}
  puts("BB_PILOT_RESULT");
  for (unsigned i = 0; i < 256; ++i) printf("%ld\\n", (long)output[i]);
  puts("BB_PILOT_END");
  return 0;
}
`
  const transpose = c.kind === 'transpose'
  return `${common}
${reference ? '' : `void bb_pilot_kernel(const int8_t *, const int8_t *, ${transpose ? '' : 'const int32_t *, '}int32_t *);`}
int main(void) {
  unsigned seed = BB_PILOT_SEED;
  static int8_t a[256] __attribute__((aligned(128))), b[256] __attribute__((aligned(128)));
  static int32_t initial[256] __attribute__((aligned(128))), output[256] __attribute__((aligned(128)));
  for (unsigned i = 0; i < 256; ++i) {
    a[i] = (int8_t)((i * 3 + seed) % 11) - 5;
    b[i] = (int8_t)((i * 7 + seed * 3) % 13) - 6;
    initial[i] = (int32_t)((i * 5 + seed) % 31) - 15;
    output[i] = 0x5a5a5a5a;
  }
  ${reference ? `for (unsigned r = 0; r < 16; ++r) for (unsigned col = 0; col < 16; ++col) {
    int32_t sum = ${transpose ? '0' : 'initial[r * 16 + col]'};
    for (unsigned k = 0; k < 16; ++k) sum += a[${transpose ? 'k * 16 + r' : 'r * 16 + k'}] * b[k * 16 + col];
    output[r * 16 + col] = sum;
  }` : `bb_pilot_kernel(a, b, ${transpose ? '' : 'initial, '}output);`}
  puts("BB_PILOT_RESULT");
  for (unsigned i = 0; i < 256; ++i) printf("%ld\\n", (long)output[i]);
  puts("BB_PILOT_END");
  return 0;
}
`
}
