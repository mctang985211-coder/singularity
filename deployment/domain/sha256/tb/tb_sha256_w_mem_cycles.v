`default_nettype none
`timescale 1ns / 1ps
module tb_sha256_w_mem_cycles;
  reg clk = 0;
  reg reset_n = 1;
  reg [511:0] block = 0;
  reg [5:0] round = 0;
  reg init = 0;
  reg next = 0;
  wire [31:0] actual, expected;
  integer cycle = 0;
  sha256_w_mem dut(clk, reset_n, block, round, init, next, actual);
  sha256_w_mem_reference reference(clk, reset_n, block, round, init, next, expected);
  always #5 clk = ~clk;
  task compare;
    begin
      #1;
      if (actual !== expected) $fatal(1, "w_mem cycle %0d differs: %08x != %08x", cycle, actual, expected);
      cycle = cycle + 1;
    end
  endtask
  initial begin
    integer b, r;
    reg [31:0] pattern;
    #2 reset_n = 0;
    compare();
    @(negedge clk); reset_n = 1;
    for (b = 0; b < 4; b = b + 1) begin
      pattern = 32'h9e3779b9 * (b + 1);
      block = {16{pattern}} ^ (512'h61626380 << (b * 32));
      init = 1; round = 0; next = 0;
      @(posedge clk); compare();
      @(negedge clk); init = 0;
      for (r = 0; r < 64; r = r + 1) begin
        round = r;
        next = 0;
        compare();
        @(posedge clk); compare();
        @(negedge clk);
        next = 1;
        compare();
        @(posedge clk); compare();
        @(negedge clk);
      end
      next = 0;
      #2 reset_n = 0;
      compare();
      @(negedge clk); reset_n = 1;
    end
    $display("*** w_mem cycle equivalence passed");
    $finish;
  end
endmodule
