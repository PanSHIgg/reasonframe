# 整篇配音适配

每个已审核的讲稿版本只向 TTS 发送一个完整文本请求。讲稿由各 scene 的 beat.say 用换行连接，场景之间空一行；SHA-256 不包含末尾额外换行。不要用字幕摘要替代实际朗读文本。

## 直接 Edge TTS（默认，无常驻服务）

安装一次 Python 依赖：

```bash
cd ai-service
uv venv .venv
uv pip install --python .venv/bin/python -r requirements-tts.txt
```

在 `ai-service/.env` 中配置：

```dotenv
TTS_PROVIDER=edge
TTS_VOICE=zh-CN-XiaoxiaoNeural
# 可选，默认 .venv/bin/python
# TTS_PYTHON=/absolute/path/to/.venv/bin/python
```

AI 服务在答案审核通过后的 `PREPARE` 阶段直接调用 `ai-service/scripts/edge-tts-cli.py`，每次完整讲稿启动一个 Python 进程，不需要启动 4311 端口或健康检查。整篇讲稿仍然只合成一次，Edge 的词边界直接写入 `words.json`；缓存命中不会重新请求。固定版本的 Edge SDK 默认按 4096 字节拆文本，适配器改为发送一个完整 SSML 消息，并把包含请求头的 UTF-8 消息限制在 60000 字节以内；超过时在请求前拒绝。缓存位于 `ai-service/.reasonframe/tts-cache/`。

答案 agent 只写已审核的整篇旁白，不直接请求 TTS。`AUTHOR` 通过后，`PREPARE` 按 `script_sha256` 合成一次 `narration.mp3`、`words.json` 和初步 `timeline.json`；视频作者生成 lesson 后服务按最终 scene blocks/cues 重新对齐，视频作者和审核者可用 `validate_preview` 刷新浏览器报告。旁白变化时旧音频自动失效，不能对未变化文本重复请求 TTS。

## 可选 HTTP TTS 适配器

如果使用外部 TTS 服务，设置：

```dotenv
TTS_PROVIDER=http
TTS_URL=https://your-tts-adapter.example/synthesize
TTS_API_KEY=optional-key
TTS_VOICE=optional-voice
```

服务向 TTS_URL 发送 POST，Content-Type 为 application/json。设置密钥后加 Bearer 头；Idempotency-Key 为讲稿摘要。适配服务应按此键处理幂等，服务不会自动重试 TTS 请求或跟随重定向。

```json
{
  "text": "完整的连续讲稿……",
  "scriptSha256": "64 位十六进制 SHA-256",
  "voice": "配置中的 voice",
  "language": "zh-CN",
  "wordTimestamps": true
}
```

返回 JSON：

```json
{
  "scriptSha256": "与请求相同，可选但建议返回",
  "audioBase64": "完整 MP3 的纯 base64",
  "words": {
    "schemaVersion": 1,
    "timeUnit": "seconds",
    "words": [
      { "text": "这道", "start": 0.12, "end": 0.42 },
      { "text": "题", "start": 0.42, "end": 0.65 }
    ]
  }
}
```

表格必须覆盖全部讲稿，来自这份 MP3 的同一次合成；上例只展示格式。支持 seconds、milliseconds、100ns，必须显式指定单位，不能靠数值猜。end 可以用 duration 代替。

接口返回体最多 64 MB，MP3 最多 44 MB，合成超时 5 分钟。较长的视频应评估实际供应商的全文长度上限并调整服务限制，不能让 SDK 静默拆分成多次合成。合成失败时任务失败，保留讲稿，客户端可以显式重试或改用外部音频导入。

## 外部 MP3 与词表

任务输入设置 `options.audio="provided"`，或不配置 TTS_PROVIDER。任务进入 awaiting_audio 后：

```bash
curl http://127.0.0.1:4310/v1/jobs/JOB_ID/narration
```

保存返回的 text 和 scriptSha256，再对全文调用你的 TTS。完成后一次提交：

```json
{
  "scriptSha256": "生成这份 MP3 时使用的讲稿摘要",
  "audioBase64": "完整 MP3 的纯 base64",
  "words": {
    "schemaVersion": 1,
    "timeUnit": "milliseconds",
    "scriptSha256": "可选的同一讲稿摘要",
    "words": [ { "text": "这道", "start": 120, "end": 420 } ]
  }
}
```

将上面的完整数据写入 audio-input.json：

```bash
curl -X POST http://127.0.0.1:4310/v1/jobs/JOB_ID/audio \
  -H 'Content-Type: application/json' \
  --data-binary @audio-input.json
```

生成 JSON 的 Python 示例（保留合成时的原始摘要，不能重新取当前摘要后冒充旧音频的摘要）：

```python
import base64, json, pathlib
payload = {
    "scriptSha256": pathlib.Path("narration.sha256").read_text().strip(),
    "audioBase64": base64.b64encode(pathlib.Path("narration.mp3").read_bytes()).decode(),
    "words": json.loads(pathlib.Path("words.json").read_text()),
}
pathlib.Path("audio-input.json").write_text(json.dumps(payload, ensure_ascii=False))
```

校验失败返回 422，任务保持 awaiting_audio，可提交修正后的整份数据。音频按原字节保存；字幕与高亮均使用这份词表。常规标点和空白在文本比对时规范化，数学运算符保留。词边界不能跨越教学 beat，提示锚点落到包含该词句的真实词边界。

时间表不是转写结果的替代品；当前版本不独立识别 MP3 中的实际文字。供应商需返回与音频一致的精确词时间，不要用强行均摊字数的估计表。
