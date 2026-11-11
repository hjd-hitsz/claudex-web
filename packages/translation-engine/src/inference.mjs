import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { EdgeTokenizer } from "./tokenizer.mjs";

export class EdgeTranslation {
  async load(directory, runtime) {
    this.ort = createRequire(join(runtime, "package.json"))("onnxruntime-node");
    this.config = JSON.parse(
      await readFile(`${directory}/config.json`, "utf8"),
    );
    this.generation = JSON.parse(
      await readFile(`${directory}/genai_config.json`, "utf8"),
    );
    this.tokenizer = new EdgeTokenizer(directory, runtime);
    if (this.generation.model.type !== "marian-ssru")
      throw new Error("不支持当前翻译模型结构");
    const options = {
      executionProviders: ["cpu"],
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    };
    this.encoder = await this.ort.InferenceSession.create(
      `${directory}/encoder.onnx`,
      options,
    );
    this.decoder = await this.ort.InferenceSession.create(
      `${directory}/decoder.onnx`,
      options,
    );
  }

  async encode(text) {
    const prefix = this.config.input_prefix.replace("{tgt_upper}", "CHS");
    return [
      ...(await this.tokenizer.encode(`${prefix}${text}`)),
      this.config.eos_id,
    ];
  }

  async translateSegment(text) {
    const ids = await this.encode(text);
    if (ids.length > this.generation.model.context_length)
      throw new Error("Source exceeds the model context length");
    const input = new this.ort.Tensor(
      "int64",
      BigInt64Array.from(ids, BigInt),
      [1, ids.length],
    );
    const mask = new this.ort.Tensor(
      "int32",
      new Int32Array(ids.length).fill(1),
      [1, ids.length],
    );
    let encoded;
    let state;
    try {
      encoded = await this.encoder.run({
        input_ids: input,
        attention_mask: mask,
      });
      const { encoder_outputs: hidden, ...projections } = encoded;
      state = new this.ort.Tensor(
        "float32",
        new Float32Array(this.config.decoder_layers * this.config.d_model),
        [this.config.decoder_layers, 1, this.config.d_model],
      );
      const tokens = [];
      let previous = this.config.bos_id;
      let ended = false;
      for (
        let position = 0;
        position < this.generation.search.max_length;
        position++
      ) {
        const token = new this.ort.Tensor(
          "int64",
          BigInt64Array.of(BigInt(previous)),
          [1],
        );
        const length = new this.ort.Tensor(
          "int64",
          BigInt64Array.of(BigInt(position)),
          [],
        );
        let output;
        try {
          output = await this.decoder.run({
            input_ids: token,
            encoder_hidden_states: hidden,
            encoder_attention_mask: mask,
            rnn_states_prev: state,
            past_key_values_length: length,
            ...projections,
          });
        } finally {
          token.dispose();
          length.dispose();
        }
        let selected = 0;
        const logits = output.logits.data;
        for (let id = 1; id < logits.length; id++)
          if (logits[id] > logits[selected]) selected = id;
        state.dispose();
        state = output.rnn_states;
        output.logits.dispose();
        if (selected === this.config.eos_id) {
          ended = true;
          break;
        }
        tokens.push(selected);
        previous = selected;
      }
      if (!ended)
        throw new Error("Decoder reached its output limit before EOS");
      return {
        text: (await this.tokenizer.decode(tokens)).trim(),
        sourceTokens: ids.length,
        outputTokens: tokens.length,
        ended,
      };
    } finally {
      state?.dispose();
      input.dispose();
      mask.dispose();
      Object.values(encoded || {}).forEach((value) => value.dispose());
    }
  }

  async translate(text, signal) {
    signal?.throwIfAborted();
    const [, before, content, after] = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!content) return { text, segments: [] };
    if (
      content.length <= 512 &&
      (await this.encode(content)).length <=
        this.generation.model.context_length
    ) {
      const result = await this.translateSegment(content);
      return { text: before + result.text + after, segments: [result] };
    }
    const sentences = [
      ...new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(
        content,
      ),
    ].map((part) => part.segment);
    if (sentences.length === 1) {
      const characters = Array.from(content);
      let boundary = characters
        .slice(0, Math.floor(characters.length / 2))
        .join("").length;
      const space = content.lastIndexOf(" ", boundary);
      if (space > boundary / 2) boundary = space + 1;
      sentences.splice(
        0,
        1,
        content.slice(0, boundary),
        content.slice(boundary),
      );
    }
    const results = [];
    for (const sentence of sentences)
      results.push(await this.translate(sentence, signal));
    return {
      text: before + results.map((result) => result.text).join("") + after,
      segments: results.flatMap((result) => result.segments),
    };
  }

  async close() {
    await Promise.allSettled([
      this.encoder?.release(),
      this.decoder?.release(),
      this.tokenizer?.close(),
    ]);
  }
}
