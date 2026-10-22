#include "Vaccelerator.h"
#include "verilated.h"
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <stdexcept>
#include <string>
#include <vector>

// This test driver is host-owned. It neither links nor translates candidate RTL
// into its reference: every expected sum is computed from accepted signed bytes.
static uint32_t random_word(uint32_t &state) {
  state ^= state << 13; state ^= state >> 17; state ^= state << 5;
  return state;
}
static void clock(Vaccelerator &dut) {
  dut.clk = 0; dut.eval(); dut.clk = 1; dut.eval();
}
static void reset(Vaccelerator &dut) {
  dut.rst_n = 0; dut.in_valid = 0; dut.out_ready = 0;
  for (int i = 0; i < 4; ++i) clock(dut);
  dut.clk = 0; dut.eval(); dut.rst_n = 1;
}
struct Beat { uint64_t a, b; bool last; uint32_t product_sum; };
static std::vector<Beat> vectors(int beats, int dots, uint32_t seed) {
  std::vector<Beat> result;
  for (int d = 0; d < dots; ++d) for (int b = 0; b < beats; ++b) {
    Beat beat{0, 0, b == beats - 1, 0};
    for (int lane = 0; lane < 8; ++lane) {
      int x = int(random_word(seed) & 255) - 128;
      int y = int(random_word(seed) & 255) - 128;
      if (d == 0 && b == 0) {
        const int xs[] = {-128,127,-1,0,1,-128,127,-1};
        const int ys[] = {-128,127,127,-128,-1,127,-128,-1};
        x = xs[lane]; y = ys[lane];
      }
      if (dots == 1 && beats == 32769) x = y = -128;
      beat.a |= uint64_t(uint8_t(x)) << (lane * 8);
      beat.b |= uint64_t(uint8_t(y)) << (lane * 8);
      beat.product_sum += uint32_t(x * y);
    }
    result.push_back(beat);
  }
  return result;
}
static unsigned simulate(int beats, int dots, uint32_t seed, bool stalls) {
  Vaccelerator dut;
  reset(dut);
  // A reset must discard a partially accumulated dot, including pipeline state.
  dut.in_valid = 1; dut.in_last = 0;
  dut.in_a = 0x0101010101010101ULL; dut.in_b = 0x0303030303030303ULL;
  bool accepted = false;
  for (int n = 0; n < 200 && !accepted; ++n) {
    dut.clk = 0; dut.eval(); accepted = dut.in_ready; clock(dut);
  }
  if (!accepted) throw std::runtime_error("input never ready after reset");
  dut.in_valid = 0;
  for (int n = 0; n < 20; ++n) clock(dut);
  reset(dut);

  const auto input = vectors(beats, dots, seed);
  std::deque<uint32_t> expected;
  size_t sent = 0; unsigned received = 0, last_cycle = 0;
  uint32_t accumulator = 0, held_data = 0;
  bool held = false, pending = false;
  for (unsigned cycle = 1; cycle <= input.size() * 32 + 200; ++cycle) {
    dut.clk = 0;
    if (!pending && sent < input.size() && (!stalls || cycle % 7 != 3)) pending = true;
    dut.in_valid = pending;
    if (sent < input.size()) {
      dut.in_a = input[sent].a; dut.in_b = input[sent].b;
      dut.in_last = input[sent].last;
    }
    dut.out_ready = !stalls || (cycle % 11 != 2 && cycle % 11 != 3 && cycle % 11 != 4);
    dut.eval();
    if (held && (!dut.out_valid || uint32_t(dut.out_data) != held_data))
      throw std::runtime_error("output changed while backpressured");
    held = dut.out_valid && !dut.out_ready; held_data = dut.out_data;
    const bool take_input = dut.in_valid && dut.in_ready;
    const bool take_output = dut.out_valid && dut.out_ready;
    if (take_input) {
      accumulator += input[sent].product_sum;
      if (input[sent].last) { expected.push_back(accumulator); accumulator = 0; }
    }
    if (take_output) {
      if (expected.empty() || uint32_t(dut.out_data) != expected.front())
        throw std::runtime_error("numeric mismatch or unsolicited result");
      expected.pop_front(); ++received; last_cycle = cycle;
    }
    dut.clk = 1; dut.eval();
    if (take_input) { ++sent; pending = false; }
    if (received == unsigned(dots) && cycle > last_cycle + 12) {
      if (sent != input.size() || !expected.empty()) throw std::runtime_error("premature output");
      return last_cycle;
    }
    if (received > unsigned(dots)) throw std::runtime_error("extra result");
  }
  throw std::runtime_error("bounded completion failed");
}
int main(int argc, char **argv) {
  Verilated::commandArgs(argc, argv);
  if (argc != 3) return 2;
  try {
    const int beats = std::stoi(argv[1]); const uint32_t seed = std::stoul(argv[2]);
    const unsigned measured = simulate(beats, 4, seed, false);
    const unsigned stalled = simulate(beats, 4, seed + 7919, true);
    const unsigned short_dot = simulate(1, 9, seed + 17, true);
    const unsigned uneven_dot = simulate(3, 7, seed + 101, true);
    // Long accumulations and an explicit overflow case exercise INT32 wraparound.
    const unsigned longer_dot = simulate(33, 5, seed + 1237, true);
    const unsigned overflow_dot = simulate(32769, 1, seed + 1999, false);
    std::printf("{\"cycles\":%u,\"functional_checks\":[%u,%u,%u,%u,%u,%u]}\n",
      measured, measured, stalled, short_dot, uneven_dot, longer_dot, overflow_dot);
  } catch (const std::exception &error) {
    std::fprintf(stderr, "%s\n", error.what()); return 1;
  }
}
