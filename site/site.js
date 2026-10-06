// Copy buttons, and the agent's cursor on the helper desktop.

function textToCopy(id) {
  const source = document.getElementById(id);
  if (!source) return "";
  const clone = source.cloneNode(true);
  // Shell prompts and file-name comments are for reading, not pasting.
  clone.querySelectorAll(".prompt, .dim").forEach((node) => node.remove());
  return clone.textContent.replace(/^\n+/, "").trimEnd();
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.setAttribute("aria-live", "polite");
  button.addEventListener("click", async () => {
    const ok = await copy(textToCopy(button.dataset.copy));
    button.textContent = ok ? "Copied" : "Press ⌘C";
    button.classList.toggle("is-done", ok);
    clearTimeout(button._reset);
    button._reset = setTimeout(() => {
      button.textContent = "Copy";
      button.classList.remove("is-done");
    }, 1800);
  });
});

// The agent's loop over the real capture: screenshot, decide, click,
// screenshot. Positions are fractions of the helper display; the arguments are
// the same spots in points (the display is 1728x1117 points).
const STEPS = [
  { x: 60, y: 55, tool: "offstage_session_screenshot", args: "1728×1117 points", capture: true },
  { x: 8.9, y: 20.1, tool: "offstage_session_input", args: "click 154 225", click: true },
  { x: 35.1, y: 26.4, tool: "offstage_session_input", args: "click 606 295", click: true },
  { x: 35.1, y: 26.4, tool: "offstage_session_input", args: 'type "coffee"' },
  { x: 35.1, y: 26.4, tool: "offstage_session_screenshot", args: "did the search run?", capture: true },
  { x: 47.8, y: 89.7, tool: "offstage_session_input", args: "click 826 1002", click: true },
];

const desk = document.querySelector(".desk");
const cursor = document.querySelector(".agent-cursor");
const ripple = document.querySelector(".agent-ripple");
const tool = document.querySelector(".agent-log-tool");
const args = document.querySelector(".agent-log-args");
const still = window.matchMedia("(prefers-reduced-motion: reduce)");

if (desk && cursor && ripple && tool && args && !still.matches) {
  let index = 0;
  let timer = null;
  let visible = false;

  const restart = (node, className) => {
    node.classList.remove(className);
    void node.offsetWidth;
    node.classList.add(className);
  };

  const step = () => {
    const s = STEPS[index];
    cursor.style.left = ripple.style.left = `${s.x}%`;
    cursor.style.top = ripple.style.top = `${s.y}%`;
    // Log the call when the cursor arrives, the way a tool result lands.
    timer = setTimeout(() => {
      tool.textContent = s.tool;
      args.textContent = s.args;
      if (s.click) restart(ripple, "is-click");
      if (s.capture) restart(desk, "is-capture");
      index = (index + 1) % STEPS.length;
      timer = setTimeout(step, 1300);
    }, 1150);
  };

  const run = () => {
    if (timer === null && visible && !document.hidden) step();
  };
  const stop = () => {
    clearTimeout(timer);
    timer = null;
  };

  new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    visible ? run() : stop();
  }).observe(desk);

  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : run()));
}
