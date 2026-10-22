// Frozen baseline: eight INT8 pairs per beat, one shared multiplier.
// Protocol: accept a beat only when in_valid && in_ready. in_last ends a dot.
// Signed INT32 wraparound sum; hold output stable until out_ready.
module accelerator (
  input wire clk, input wire rst_n,
  input wire in_valid, output wire in_ready,
  input wire [63:0] in_a, input wire [63:0] in_b,
  input wire in_last,
  output reg out_valid, input wire out_ready,
  output reg signed [31:0] out_data
);
  reg busy;
  reg [63:0] a, b;
  reg last;
  reg [2:0] lane;
  reg signed [31:0] acc;
  wire signed [7:0] x = a[7:0];
  wire signed [7:0] y = b[7:0];
  wire signed [15:0] product = x * y;
  wire signed [31:0] sum = acc + {{16{product[15]}},product};
  assign in_ready = !busy && !out_valid;
  always @(posedge clk) begin
    if (!rst_n) begin
      busy <= 0; a <= 0; b <= 0; last <= 0; lane <= 0;
      acc <= 0; out_valid <= 0; out_data <= 0;
    end else begin
      if (out_valid && out_ready) out_valid <= 0;
      if (in_valid && in_ready) begin
        busy <= 1; a <= in_a; b <= in_b; last <= in_last; lane <= 0;
      end
      if (busy) begin
        a <= a >> 8; b <= b >> 8;
        if (lane == 7) begin
          busy <= 0;
          if (last) begin out_data <= sum; out_valid <= 1; acc <= 0; end
          else acc <= sum;
        end else begin lane <= lane + 1'b1; acc <= sum; end
      end
    end
  end
endmodule
