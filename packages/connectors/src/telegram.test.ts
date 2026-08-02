import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { channelPreviewUrl, fetchChannelPosts, parseChannelPosts } from "./telegram";

// Фикстура по РЕАЛЬНОЙ разметке t.me/s/<канал>: data-post на обёртке,
// tgme_widget_message_text — текст, <time datetime> — время, footer после.
const FIXTURE = `
<div class="tgme_widget_message" data-post="promtjam/414">
  <div class="tgme_widget_message_text js-message_text">Vendhub VHD — <a href="https://github.com/x/vhd">репо</a></div>
  <div class="tgme_widget_message_footer"><time datetime="2026-07-22T15:56:13+00:00">15:56</time></div>
</div>
<div class="tgme_widget_message" data-post="promtjam/415">
  <div class="tgme_widget_message_photo"></div>
  <div class="tgme_widget_message_footer"><time datetime="2026-07-22T16:00:00+00:00">16:00</time></div>
</div>
<div class="tgme_widget_message" data-post="promtjam/416">
  <div class="tgme_widget_message_text js-message_text">OmniRoute<br/>AI-gateway, <a href="https://t.me/promtjam/1">внутр</a> и <a href="https://omni.example">сайт</a></div>
  <div class="tgme_widget_message_footer"><time datetime="2026-07-23T03:30:11+00:00">03:30</time></div>
</div>`;

describe("channelPreviewUrl", () => {
  it("нормализует имя канала", () => {
    assert.equal(channelPreviewUrl("@promtjam"), "https://t.me/s/promtjam");
    assert.equal(channelPreviewUrl("promtjam"), "https://t.me/s/promtjam");
    assert.equal(channelPreviewUrl(" @promtjam/ "), "https://t.me/s/promtjam");
  });
});

describe("parseChannelPosts", () => {
  it("разбирает текстовые посты, пропускает медиа-пост без текста", () => {
    const posts = parseChannelPosts(FIXTURE);
    assert.equal(posts.length, 2, "415 — медиа без текста, пропущен");
    assert.equal(posts[0].id, "promtjam/414");
    assert.equal(posts[0].num, 414);
    assert.match(posts[0].text, /Vendhub VHD/);
    assert.equal(posts[0].datetime, "2026-07-22T15:56:13+00:00");
  });

  it("собирает внешние ссылки без дублей, внутренние t.me тоже как http", () => {
    const posts = parseChannelPosts(FIXTURE);
    const omni = posts.find((p) => p.id === "promtjam/416");
    assert.ok(omni);
    assert.ok(omni.links.includes("https://omni.example"));
    assert.ok(omni.links.includes("https://t.me/promtjam/1"));
  });

  it("пустой/битый HTML → пустой список (не падает)", () => {
    assert.deepEqual(parseChannelPosts(""), []);
    assert.deepEqual(parseChannelPosts("<html>нет постов</html>"), []);
  });
});

describe("fetchChannelPosts", () => {
  it("забирает превью и разбирает (fetcher инъектируется)", async () => {
    const posts = await fetchChannelPosts("@promtjam", async (url) => {
      assert.equal(url, "https://t.me/s/promtjam");
      return FIXTURE;
    });
    assert.equal(posts.length, 2);
  });
});
