import { describe, expect, it } from "vitest";
import type { WeixinMessage } from "../vendor/openclaw-weixin/src/api/types.js";
import { MessageItemType } from "../vendor/openclaw-weixin/src/api/types.js";
import { weixinMessageToMsgContext } from "../vendor/openclaw-weixin/src/messaging/inbound.js";

function buildMessage(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    from_user_id: "wx-user",
    create_time_ms: 1_712_345_678_901,
    item_list: [
      {
        type: MessageItemType.TEXT,
        text_item: { text: "不要调用任何工具，只回复：橙子" },
      },
    ],
    ...overrides,
  };
}

describe("weixin inbound MessageSid", () => {
  it("uses message_id as a stable MessageSid when present", () => {
    const message = buildMessage({ message_id: 7446192514241110000, seq: 8 });

    const first = weixinMessageToMsgContext(message, "account-a");
    const second = weixinMessageToMsgContext(message, "account-a");

    expect(first.MessageSid).toBe("msg:7446192514241110000");
    expect(second.MessageSid).toBe(first.MessageSid);
  });

  it("falls back to a stable derived MessageSid when message_id is missing", () => {
    const message = buildMessage({ message_id: undefined, seq: 8 });

    const first = weixinMessageToMsgContext(message, "account-a");
    const second = weixinMessageToMsgContext(message, "account-a");

    expect(first.MessageSid).toBe(second.MessageSid);
    expect(first.MessageSid.startsWith("fallback:8:wx-user:1712345678901:")).toBe(true);
  });

  it("changes fallback MessageSid when the message body changes", () => {
    const base = buildMessage({ message_id: undefined, seq: 8 });
    const changed = buildMessage({
      message_id: undefined,
      seq: 8,
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: "不要调用任何工具，只回复：香蕉" },
        },
      ],
    });

    const first = weixinMessageToMsgContext(base, "account-a");
    const second = weixinMessageToMsgContext(changed, "account-a");

    expect(first.MessageSid).not.toBe(second.MessageSid);
  });
});
