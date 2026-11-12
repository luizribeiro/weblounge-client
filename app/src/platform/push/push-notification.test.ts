import { describe, expect, it } from "vitest";
import { chatNotification } from "./push-notification";

const mention = {
  networkLabel: "weblounge",
  buffer: "#Lounge",
  direct: false,
  sender: "mel",
  action: false,
  text: "luiz: the deploy is green",
  msgid: "msg-41",
  time: "2026-11-12T15:04:05.000Z",
};

describe("chatNotification", () => {
  it("names the channel and routes to it", () => {
    expect(chatNotification(mention)).toEqual({
      title: "mel in #Lounge",
      options: {
        body: "luiz: the deploy is green",
        tag: "weblounge/#lounge",
        data: {
          route: "/weblounge/Lounge",
          conversationTag: "weblounge/#lounge",
          messageId: "msg-41",
          messageTime: "2026-11-12T15:04:05.000Z",
        },
      },
    });
  });

  it("titles a direct message with the sender and routes to the DM", () => {
    const presentation = chatNotification({
      ...mention,
      buffer: "Mel",
      direct: true,
      sender: "Mel",
      text: "are you around?",
    });

    expect(presentation.title).toBe("Mel");
    expect(presentation.options.tag).toBe("weblounge/mel");
    expect(presentation.options.data).toMatchObject({
      route: "/weblounge/@Mel",
    });
  });

  it("renders an action as prose", () => {
    const presentation = chatNotification({
      ...mention,
      action: true,
      text: "waves at luiz",
    });

    expect(presentation.options.body).toBe("* mel waves at luiz");
  });
});
