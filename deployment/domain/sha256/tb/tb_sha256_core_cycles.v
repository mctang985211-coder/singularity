`default_nettype none
`timescale 1ns / 1ps
module tb_sha256_core_cycles;
  reg clk = 0;
  reg reset_n = 1;
  reg init = 0;
  reg next = 0;
  reg mode = 0;
  reg [511:0] block = 0;
  wire ready, reference_ready, valid, reference_valid;
  wire [255:0] digest, reference_digest;
  integer cycle = 0;
  sha256_core dut(clk, reset_n, init, next, mode, block, ready, digest, valid);
  sha256_core_reference reference(clk, reset_n, init, next, mode, block, reference_ready, reference_digest, reference_valid);
  always #5 clk = ~clk;
  always @(posedge clk or negedge reset_n) begin
    #1;
    if ({ready, valid, digest} !== {reference_ready, reference_valid, reference_digest})
      $fatal(1, "core public ports differ at cycle %0d, SHA%0d", cycle, mode ? 256 : 224);
    cycle = cycle + 1;
  end
  initial begin
    integer m, b;
    reg [31:0] pattern;
    #2 reset_n = 0;
    @(negedge clk); reset_n = 1;
    for (m = 0; m < 2; m = m + 1) begin
      mode = m;
      for (b = 0; b < 3; b = b + 1) begin
        pattern = 32'h9e3779b9 * (b + 1);
        block = {16{pattern}};
        init = b == 0;
        next = b != 0;
        @(negedge clk); init = 0; next = 0;
        repeat (70) @(negedge clk);
      end
      init = 1;
      @(negedge clk); init = 0;
      repeat (17) @(negedge clk);
      #2 reset_n = 0;
      @(negedge clk); reset_n = 1;
    end
    $display("*** SHA224/SHA256 core cycle equivalence passed");
    $finish;
  end
endmodule
