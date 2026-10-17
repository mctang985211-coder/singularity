# Yosys synthesis

The input `sha256.v` contains the upstream `sha256_k_constants`, `sha256_w_mem`, and `sha256_core` modules from secworks/sha256 commit `837c5cc396f001d18f2c765721c585716eb439ae`.

Use Yosys 0.69+post, its bundled ABC, and the sky130hd TT/25°C/1.80V Liberty file. From the task workspace, this command synthesizes the submitted `rtl/sha256.v`:

```sh
/nix/store/qh2djvg55jzqsb2xlrsh8hjfaj114jbq-yosys-0.69/bin/yosys -p 'read_liberty -lib /home/ROXY/singularity-next/labs/sky130hd-lib/sky130hd_tt_025C_1v80.lib; read_verilog rtl/sha256.v; synth -top sha256_core; dfflibmap -liberty /home/ROXY/singularity-next/labs/sky130hd-lib/sky130hd_tt_025C_1v80.lib; abc -exe /nix/store/qh2djvg55jzqsb2xlrsh8hjfaj114jbq-yosys-0.69/bin/yosys-abc -liberty /home/ROXY/singularity-next/labs/sky130hd-lib/sky130hd_tt_025C_1v80.lib; stat -liberty /home/ROXY/singularity-next/labs/sky130hd-lib/sky130hd_tt_025C_1v80.lib'
```

The metric is the final `Chip area for top module '\sha256_core'` value in µm², including the complete mapped hierarchy. Keep the passes, library, and top module fixed, without flattening. The unchanged input measures 64858.4544 µm².
