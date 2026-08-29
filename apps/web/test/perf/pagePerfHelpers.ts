import type { Page } from "playwright";

import type { PerfAppHarness } from "./appHarness";

export async function ensureThreadRowVisible(
  page: Page,
  projectTitle: string,
  threadId: string,
): Promise<void> {
  const threadRow = page.getByTestId(`thread-row-${threadId}`);
  if (await threadRow.isVisible().catch(() => false)) {
    return;
  }

  const settledToggle = page.getByTestId("sidebar-settled-shelf-toggle");
  if (await settledToggle.isVisible().catch(() => false)) {
    const expanded = await settledToggle.getAttribute("aria-expanded");
    if (expanded === "false") {
      await settledToggle.click();
    }
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await threadRow.isVisible().catch(() => false)) {
      return;
    }
    const showMore = page.getByRole("button", { name: /Show \d+ more/ });
    if (!(await showMore.isVisible().catch(() => false))) {
      break;
    }
    await showMore.click();
  }

  if (await threadRow.isVisible().catch(() => false)) {
    return;
  }

  const projectToggle = page.getByText(projectTitle, { exact: true }).first();
  await projectToggle.click();
  await threadRow.waitFor({ state: "visible", timeout: 20_000 });
}

export async function waitForThreadRoute(
  page: Page,
  input: {
    readonly threadId: string;
    readonly messageId?: string;
    readonly extraSelector?: string;
  },
): Promise<void> {
  const pathSuffix = `/${encodeURIComponent(input.threadId)}`;
  const threadSelector = `[data-testid="chat-thread-${input.threadId}"]`;
  try {
    await page.waitForFunction(
      ({ expectedPathSuffix, threadSelector, messageSelector, extraSelector }) => {
        const pathMatches = window.location.pathname.endsWith(expectedPathSuffix);
        if (!pathMatches) {
          return false;
        }
        if (!document.querySelector(threadSelector)) {
          return false;
        }

        if (messageSelector && !document.querySelector(messageSelector)) {
          return false;
        }
        if (extraSelector && !document.querySelector(extraSelector)) {
          return false;
        }
        return true;
      },
      {
        expectedPathSuffix: pathSuffix,
        threadSelector,
        messageSelector: input.messageId ? `[data-message-id="${input.messageId}"]` : null,
        extraSelector: input.extraSelector ?? null,
      },
      { timeout: 45_000 },
    );
  } catch (error) {
    const snapshot = await page.evaluate(
      ({ expectedPathSuffix, threadSelector, messageSelector }) => ({
        pathname: window.location.pathname,
        expectedPathSuffix,
        hasThread: Boolean(document.querySelector(threadSelector)),
        hasMessage: messageSelector ? Boolean(document.querySelector(messageSelector)) : null,
        messageCount: document.querySelectorAll("[data-message-id]").length,
        timelineRows: document.querySelectorAll("[data-timeline-row-kind]").length,
      }),
      {
        expectedPathSuffix: pathSuffix,
        threadSelector,
        messageSelector: input.messageId ? `[data-message-id="${input.messageId}"]` : null,
      },
    );
    throw new Error(
      `waitForThreadRoute timed out. ${JSON.stringify(snapshot)}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function measureThreadSwitch(
  harness: PerfAppHarness,
  input: {
    readonly actionName: string;
    readonly projectTitle: string;
    readonly threadId: string;
    readonly messageId?: string;
    readonly extraSelector?: string;
  },
): Promise<number | null> {
  await ensureThreadRowVisible(harness.page, input.projectTitle, input.threadId);
  await harness.startAction(input.actionName);
  await harness.page.getByTestId(`thread-row-${input.threadId}`).click();
  await waitForThreadRoute(harness.page, {
    threadId: input.threadId,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.extraSelector ? { extraSelector: input.extraSelector } : {}),
  });
  return await harness.endAction(input.actionName);
}

export async function scrollTimelineTo(page: Page, position: "top" | "bottom"): Promise<void> {
  await page.evaluate(async (targetPosition) => {
    const viewport = document.querySelector<HTMLElement>('[data-timeline-scroll-root="true"]');
    const scrollContainer =
      viewport?.firstElementChild instanceof HTMLElement ? viewport.firstElementChild : viewport;
    if (!scrollContainer) {
      throw new Error("Messages scroll container not found.");
    }

    scrollContainer.scrollTo({
      top: targetPosition === "bottom" ? scrollContainer.scrollHeight : 0,
      behavior: "auto",
    });

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }, position);
}

export async function typeIntoComposerAndSend(page: Page, message: string): Promise<void> {
  const editor = page.getByTestId("composer-editor");
  await editor.click();
  await page.keyboard.type(message);
  await page.getByRole("button", { name: "Send message" }).click();
}
