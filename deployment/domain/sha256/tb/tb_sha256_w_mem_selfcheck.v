//==============================================================================
//
// tb_sha256_w_mem_selfcheck.v
// ---------------------------
// The functional judgement of deployment/domain/sha256: the graded module is
// driven through init/round/next like sha256_core drives it, and the `w` port is
// compared, round by round, against the message schedule of two published NIST
// messages. It is self-checking: the pass line below is printed only when every
// word of every block matched, and a mismatched word is both printed and exits
// non-zero.
//
// The expected words are not transcribed from the specification. They are printed
// by tools/w-schedule.mjs, a SHA-256 implementation whose digest routine
// reproduces three published NIST vectors before it will print anything.
//
// The lab testbench this replaces printed its results and compared nothing; this
// one has exactly one way to print the pass line.
//
//==============================================================================

`default_nettype none
`timescale 1ns / 1ps

module tb_sha256_w_mem_selfcheck;

  localparam integer BLOCKS = 3;
  localparam integer ROUNDS = 64;

  reg           clk = 1'b0;
  reg           reset_n = 1'b0;
  reg  [511 : 0] block = 512'b0;
  reg  [5 : 0]   round = 6'b0;
  reg            init = 1'b0;
  reg            next = 1'b0;
  wire [31 : 0]  w;

  reg [31 : 0] expected [0 : BLOCKS * ROUNDS - 1];
  integer errors = 0;

  sha256_w_mem dut(.clk(clk),
                   .reset_n(reset_n),
                   .block(block),
                   .round(round),
                   .init(init),
                   .next(next),
                   .w(w));

  always #5 clk = ~clk;

  // The message schedule, word by word, of the blocks the run below drives:
  // "abc", then the 112-byte NIST message, which is two blocks.
  initial begin : load_expected
      expected[0] = 32'h61626380; expected[1] = 32'h00000000; expected[2] = 32'h00000000; expected[3] = 32'h00000000; expected[4] = 32'h00000000; expected[5] = 32'h00000000; expected[6] = 32'h00000000; expected[7] = 32'h00000000;
      expected[8] = 32'h00000000; expected[9] = 32'h00000000; expected[10] = 32'h00000000; expected[11] = 32'h00000000; expected[12] = 32'h00000000; expected[13] = 32'h00000000; expected[14] = 32'h00000000; expected[15] = 32'h00000018;
      expected[16] = 32'h61626380; expected[17] = 32'h000f0000; expected[18] = 32'h7da86405; expected[19] = 32'h600003c6; expected[20] = 32'h3e9d7b78; expected[21] = 32'h0183fc00; expected[22] = 32'h12dcbfdb; expected[23] = 32'he2e2c38e;
      expected[24] = 32'hc8215c1a; expected[25] = 32'hb73679a2; expected[26] = 32'he5bc3909; expected[27] = 32'h32663c5b; expected[28] = 32'h9d209d67; expected[29] = 32'hec8726cb; expected[30] = 32'h702138a4; expected[31] = 32'hd3b7973b;
      expected[32] = 32'h93f5997f; expected[33] = 32'h3b68ba73; expected[34] = 32'haff4ffc1; expected[35] = 32'hf10a5c62; expected[36] = 32'h0a8b3996; expected[37] = 32'h72af830a; expected[38] = 32'h9409e33e; expected[39] = 32'h24641522;
      expected[40] = 32'h9f47bf94; expected[41] = 32'hf0a64f5a; expected[42] = 32'h3e246a79; expected[43] = 32'h27333ba3; expected[44] = 32'h0c4763f2; expected[45] = 32'h840abf27; expected[46] = 32'h7a290d5d; expected[47] = 32'h065c43da;
      expected[48] = 32'hfb3e89cb; expected[49] = 32'hcc7617db; expected[50] = 32'hb9e66c34; expected[51] = 32'ha9993667; expected[52] = 32'h84badedd; expected[53] = 32'hc21462bc; expected[54] = 32'h1487472c; expected[55] = 32'hb20f7a99;
      expected[56] = 32'hef57b9cd; expected[57] = 32'hebe6b238; expected[58] = 32'h9fe3095e; expected[59] = 32'h78bc8d4b; expected[60] = 32'ha43fcf15; expected[61] = 32'h668b2ff8; expected[62] = 32'heeaba2cc; expected[63] = 32'h12b1edeb;
      expected[64] = 32'h61626364; expected[65] = 32'h65666768; expected[66] = 32'h62636465; expected[67] = 32'h66676869; expected[68] = 32'h63646566; expected[69] = 32'h6768696a; expected[70] = 32'h64656667; expected[71] = 32'h68696a6b;
      expected[72] = 32'h65666768; expected[73] = 32'h696a6b6c; expected[74] = 32'h66676869; expected[75] = 32'h6a6b6c6d; expected[76] = 32'h6768696a; expected[77] = 32'h6b6c6d6e; expected[78] = 32'h68696a6b; expected[79] = 32'h6c6d6e6f;
      expected[80] = 32'ha8ebabad; expected[81] = 32'h0641038d; expected[82] = 32'h7172a698; expected[83] = 32'h497a623a; expected[84] = 32'h98cd8137; expected[85] = 32'he8f7c5f8; expected[86] = 32'hc2b50678; expected[87] = 32'h718a8426;
      expected[88] = 32'hde8fc323; expected[89] = 32'hf183209d; expected[90] = 32'hd626e3d8; expected[91] = 32'hba135802; expected[92] = 32'hc8e3f77d; expected[93] = 32'h76982806; expected[94] = 32'he826002b; expected[95] = 32'h00c34d3f;
      expected[96] = 32'hb4c130c7; expected[97] = 32'h430ae5d1; expected[98] = 32'hcf0f462b; expected[99] = 32'h5d06722b; expected[100] = 32'h78fa33fd; expected[101] = 32'h70b34550; expected[102] = 32'h06f35b93; expected[103] = 32'h9d0ddfcc;
      expected[104] = 32'hd6492697; expected[105] = 32'h2869a94d; expected[106] = 32'haf10bcdb; expected[107] = 32'h33e5828b; expected[108] = 32'h8bb44c08; expected[109] = 32'hb9820093; expected[110] = 32'he231c8c3; expected[111] = 32'hed428890;
      expected[112] = 32'hcdfef4f3; expected[113] = 32'ha771e3e1; expected[114] = 32'h6959bf93; expected[115] = 32'h2f71e587; expected[116] = 32'h9a40d684; expected[117] = 32'h119508bb; expected[118] = 32'h6352b985; expected[119] = 32'h0d1ba786;
      expected[120] = 32'h7eb48046; expected[121] = 32'hc67ec7cd; expected[122] = 32'h1f70b7bb; expected[123] = 32'h9cb8e144; expected[124] = 32'h9ade2fb1; expected[125] = 32'h73355010; expected[126] = 32'h5faca95b; expected[127] = 32'hb126d386;
      expected[128] = 32'h696a6b6c; expected[129] = 32'h6d6e6f70; expected[130] = 32'h6a6b6c6d; expected[131] = 32'h6e6f7071; expected[132] = 32'h6b6c6d6e; expected[133] = 32'h6f707172; expected[134] = 32'h6c6d6e6f; expected[135] = 32'h70717273;
      expected[136] = 32'h6d6e6f70; expected[137] = 32'h71727374; expected[138] = 32'h6e6f7071; expected[139] = 32'h72737475; expected[140] = 32'h80000000; expected[141] = 32'h00000000; expected[142] = 32'h00000000; expected[143] = 32'h00000380;
      expected[144] = 32'h5187e94b; expected[145] = 32'hea10c1b0; expected[146] = 32'h1984ef60; expected[147] = 32'h32252c97; expected[148] = 32'h4b335147; expected[149] = 32'h2c151399; expected[150] = 32'he37902d0; expected[151] = 32'h64591cf5;
      expected[152] = 32'h729b9b87; expected[153] = 32'h6c01d729; expected[154] = 32'h98fc63fa; expected[155] = 32'ha01181b1; expected[156] = 32'h69b93412; expected[157] = 32'hd43fe33a; expected[158] = 32'h21ca3512; expected[159] = 32'he72c0501;
      expected[160] = 32'h66a6e9f6; expected[161] = 32'hfe01bc6f; expected[162] = 32'hc677ea90; expected[163] = 32'hd905bf9e; expected[164] = 32'h9adbdde1; expected[165] = 32'hb30829f9; expected[166] = 32'h018e1943; expected[167] = 32'hc346cdbb;
      expected[168] = 32'h6ab93db1; expected[169] = 32'hf0a4dcb8; expected[170] = 32'h42a4d50d; expected[171] = 32'h95c57d87; expected[172] = 32'ha4da34ec; expected[173] = 32'h9462a03c; expected[174] = 32'h603f94a9; expected[175] = 32'hb0860c0b;
      expected[176] = 32'h3f4d2620; expected[177] = 32'hcc354466; expected[178] = 32'hdd8e3dea; expected[179] = 32'haf835208; expected[180] = 32'hf8374ec4; expected[181] = 32'hd7188100; expected[182] = 32'hdd19b919; expected[183] = 32'h7417ba8d;
      expected[184] = 32'h7b63035f; expected[185] = 32'h1fcfafab; expected[186] = 32'h16f5716c; expected[187] = 32'hf10dc802; expected[188] = 32'h563c9f43; expected[189] = 32'h8aa794dd; expected[190] = 32'h3326bfec; expected[191] = 32'h72e01ea7;
  end

  // Drive one block: load its first sixteen words, then walk the rounds, checking
  // the produced word and advancing the sliding window exactly as the core does.
  task check_block(input integer index, input integer base);
    integer r;
    begin
      @(negedge clk);
      block = {expected[base],      expected[base + 1],  expected[base + 2],  expected[base + 3],
               expected[base + 4],  expected[base + 5],  expected[base + 6],  expected[base + 7],
               expected[base + 8],  expected[base + 9],  expected[base + 10], expected[base + 11],
               expected[base + 12], expected[base + 13], expected[base + 14], expected[base + 15]};
      init = 1'b1;
      round = 6'd0;
      next = 1'b0;
      @(posedge clk);
      @(negedge clk);
      init = 1'b0;

      for (r = 0; r < ROUNDS; r = r + 1) begin
        @(negedge clk);
        round = r[5 : 0];
        next = (r >= 16);
        #1;
        if (w !== expected[base + r]) begin
          errors = errors + 1;
          $display("statement mismatch: block %0d round %0d expected %08x, module produced %08x", index, r, expected[base + r], w);
        end
      end

      @(negedge clk);
      next = 1'b0;
    end
  endtask

  initial begin : run
    integer index;
    reset_n = 1'b0;
    #23 reset_n = 1'b1;

    for (index = 0; index < BLOCKS; index = index + 1)
      check_block(index, index * ROUNDS);

    if (errors === 0) $display("*** sha256_w_mem self-check passed: %0d blocks, %0d words", BLOCKS, BLOCKS * ROUNDS);
    else $fatal(1, "*** sha256_w_mem self-check failed: %0d of %0d words wrong", errors, BLOCKS * ROUNDS);
    $finish;
  end

endmodule
