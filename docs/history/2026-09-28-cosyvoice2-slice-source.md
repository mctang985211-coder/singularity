# CosyVoice2 首轮 Buckyball 切片：固定来源调查

调查日期：2026-09-28。只读核对官方源码和当前 Buckyball 检出；未下载权重、未运行导入或仿真，下面的可执行性判断均标明边界。

## 选择

首轮选择 **CosyVoice2 flow encoder 的 `PreLookaheadLayer`，无 context 的推理分支**。它是官方 `UpsampleConformerEncoder` 的第一段：输入和输出都是 `[B,T,512]`，执行两次一维卷积、LeakyReLU 和残差相加，不需要先实现 token embedding、Conformer attention、扩采样、flow decoder 或 HiFT。它足以验证「真实模型子图 → 官方参考张量 → Buckyball workload → 模拟器结果比较」的流程，但通过它不能宣称 CosyVoice2 全模型或芯片适配完成。[官方配置](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/examples/libritts/cosyvoice2/conf/cosyvoice2.yaml#L38-L64)；[模块及调用位置](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/cosyvoice/transformer/upsample_encoder.py#L66-L103)、[L276-L294](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/cosyvoice/transformer/upsample_encoder.py#L276-L294)。

`Upsample1D` 是下一片，不宜首轮混入：它先做 nearest 插值，再左补零并做 512→512、kernel 5 的一维卷积，随后还有四个上采样 Conformer block。增加它会同时引入长度改变和插值算子，掩盖首轮卷积链是否可导入的结论。[官方定义](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/cosyvoice/transformer/upsample_encoder.py#L37-L63)、[encoder 组装](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/cosyvoice/transformer/upsample_encoder.py#L203-L239)。

## 固定合同和来源

| 项 | 首轮合同 | 来源／推导 |
|---|---|---|
| 代码版本 | `QwenAudio/CosyVoice` 对应的官方 `FunAudioLLM/CosyVoice` commit `074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc` | [固定提交](https://github.com/QwenAudio/CosyVoice/commit/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc)；[固定配置](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/examples/libritts/cosyvoice2/conf/cosyvoice2.yaml) |
| 模型位置 | flow 的 encoder，位于 Conformer blocks 和上采样之前 | [encoder.forward](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/cosyvoice/transformer/upsample_encoder.py#L276-L294) |
| 输入 | float32、`[1,25,512]`、无 context；25 是配置的 streaming chunk 大小，512 是 encoder input/output size；形状是首轮固定测试实例，并非官方规定唯一合法 T | [配置 L16-L18、L38-L63](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/examples/libritts/cosyvoice2/conf/cosyvoice2.yaml#L16-L63)；[模块输入注释](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/cosyvoice/transformer/upsample_encoder.py#L82-L90) |
| 卷积 1 | 512→512，kernel 4，stride 1；无 context 时右补 3；LeakyReLU | [PreLookaheadLayer 定义与 forward](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/cosyvoice/transformer/upsample_encoder.py#L66-L96)；配置 `pre_lookahead_len: 3` [L47](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/examples/libritts/cosyvoice2/conf/cosyvoice2.yaml#L38-L49) |
| 卷积 2 | 512→512，kernel 3，stride 1；左补 2；加原输入残差 | [forward L95-L103](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/cosyvoice/transformer/upsample_encoder.py#L95-L103) |
| 输出 | `[1,25,512]`；由两次 padding 与无 padding 卷积的长度公式得出，官方代码最后与原输入相加也要求同形状 | [forward L89-L103](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/cosyvoice/transformer/upsample_encoder.py#L89-L103) |

固定数值输入须由测试夹具保存。若声称是模型运行中的真实切片，输入应从同一 checkpoint 的官方 `flow.encoder.embed` 输出捕获，并保留生成它的 token/length 与导出脚本；仅用固定随机输入则只证明该层对任意合法输入的执行。参考输出须直接调用该提交的官方 PyTorch `PreLookaheadLayer.eval()` 生成并保存完整 tensor；比较同一权重、输入、dtype、输出顺序。容差需在实际数值实验后写入合同，不能在来源调查中预设一个“必过”的阈值。[官方调用链](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/cosyvoice/transformer/upsample_encoder.py#L276-L289)。

## 权重与可证实范围

若目标只是 **算子/编译通路探针**，可以用固定种子初始化层权重，完全不需要下载 checkpoint；结果只能称为官方层定义的合成权重切片。若要声称 **CosyVoice2 模型切片**，必须用官方 `flow.pt` 中 `encoder.pre_lookahead_layer` 对应参数，并固定模型仓库 revision 与权重校验和。官方加载器以 `strict=True` 读取 `flow.pt`，并将 flow 置于 eval 模式；CosyVoice2 的 CLI 也确实加载该文件。[加载器](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/cosyvoice/cli/model.py#L65-L73)、[CosyVoice2 CLI](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/cosyvoice/cli/cosyvoice.py#L139-L169)。

官方 [CosyVoice2-0.5B 模型仓库](https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B) 在本次查询时的 revision 是 `eec1ae6c79877dbd9379285cf8789c9e0879293d`；其 [`flow.pt`](https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B/blob/eec1ae6c79877dbd9379285cf8789c9e0879293d/flow.pt) 为 450,575,567 字节，LFS SHA-256 为 `ff4c2f867674411e0a08cee702996df13fa67c1cd864c06108da88d16d088541`，见[模型文件 API](https://huggingface.co/api/models/FunAudioLLM/CosyVoice2-0.5B/tree/eec1ae6c79877dbd9379285cf8789c9e0879293d?recursive=true)。模型 revision 与代码 commit 属两个独立的 pin；未加载权重验证该快照和源码类定义完全匹配。正式试跑时若 `strict=True` 或参数筛选失败，应报告输入不匹配，不能自造映射兜底。

## Buckyball 路径是否吻合

- Buckyball 已有 ModelTest 模型导入与固定输出比较先例：[SmolLM2 HANDOFF](/home/ROXY/code/bb_work/buckyball/bb-tests/workloads/src/ModelTest/e2e/models/models/SmolLM2/HANDOFF.md)；已有卷积模型导入及逐 stage 对照先例：[MobileNetV3 importer](/home/ROXY/code/bb_work/buckyball/bb-tests/workloads/src/ModelTest/e2e/models/models/MobileNetV3/buddy-mobilenetv3-import.py)、[BEMU stage compare](/home/ROXY/code/bb_work/buckyball/bb-tests/workloads/src/ModelTest/e2e/models/models/MobileNetV3/compare-bemu-stages.py)。这些证明**验证路线存在**，不证明当前 `Conv1d` 可直接导入。
- 现有 pebble `im2col` CTest 使用的是二维卷积窗口和量化整型路径，见[conv_im2col_test.c](/home/ROXY/code/bb_work/buckyball/examples/chips/pebble/workloads/ctests/conv_im2col_test.c) 与 [MobileNetV3 Buckyball CMake](/home/ROXY/code/bb_work/buckyball/bb-tests/workloads/src/ModelTest/e2e/models/archs/buckyball/pebble/MobileNetV3/CMakeLists.txt)。本切片是 **float32 一维卷积、512 通道**；不能把已有 im2col/conv2d Ball 当作直接覆盖。先做 Dynamo→MLIR 导入，再试现有 host/RISC-V CPU lowering 并用 BEMU 对照；若降到 CPU，报告为「Buckyball 平台执行、Ball 加速 0」，不能报告为卷积 Ball 验证通过。
- 因此首轮根任务的客观闸门应是：冻结输入与真实/合成权重来源；官方 PyTorch 输出可重现；导入产生明确 IR；生成的二进制在 BEMU 运行并输出完整张量；与官方参考按事先冻结的容差比较。导入不支持、编译不支持或 BEMU 不一致均是有效 FAIL，交给下一节点定位，不自动扩展成新 Ball、整颗芯片或全模型改造。RTL 与新芯片是后续独立任务。

夹具来源说明：当前 Buckyball `.agents/skills` 是已跟踪 git submodule，gitlink `df200963b04b19b2a75bbcf407ab2c649e8b64ba`；里面的 `chip-designer` 可供后续设计节点用。当前检出没有 `.dsh/skills/` 目录，legacy 插件提示中对它的引用需要在实际 env-builder 会话中验证，不应把这两个目录混为一谈。
