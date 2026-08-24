# offstage-web: the container lane's Xvfb box.
#
# WHAT THIS IS
#   A Debian image that runs *headed* browser work against a real X server with a
#   real window manager, entirely inside the container. Nothing it draws can
#   reach the host display: no X socket is forwarded in, there is no VNC and no
#   Wayland passthrough. The only way a pixel leaves this image is as a PNG in
#   the artifacts mount.
#
#   The illusion, bottom up:
#     Xvfb      : an X server whose framebuffer is plain memory, no hardware.
#     fluxbox   : a window manager, so windows are mapped, focused and sized the
#                 way a real desktop does it. Browsers behave differently with no
#                 WM (no focus events, odd window geometry), and "behaves like a
#                 real desktop" is the entire reason this lane exists.
#     imagemagick + x11-apps: `import` (with an `xwd | convert` fallback) grabs
#                 the root window at the end of the run. That screenshot is the
#                 only evidence a human gets that the headed run really rendered.
#
# MEASURED SIZE
#   689 MB uncompressed on arm64: node:20-bookworm-slim (~220 MB) plus the X
#   server, window manager, fonts and Chromium's shared-library set. A cold
#   build takes about a minute, dominated by package downloads; rebuilds after
#   an edit to this directory are seconds, because only the final layers change.
#   Re-check with `docker images offstage-web` if the package list changes.

FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      fluxbox \
      x11-utils \
      x11-apps \
      x11-xserver-utils \
      dbus-x11 \
      imagemagick \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-unifont \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libwayland-client0 \
      libx11-6 \
      libx11-xcb1 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      libxshmfence1 \
      ca-certificates \
      procps \
    && rm -rf /var/lib/apt/lists/*

# Persistent browser-cache mount point. Created here rather than left to the
# volume so a run without the volume still has a writable path.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Defaults only; the lane overrides these per run so concurrent containers never
# argue over a display number or a screen size.
ENV OFFSTAGE_DISPLAY_NUM=99 \
    OFFSTAGE_SCREEN=1280x900x24 \
    OFFSTAGE_ARTIFACTS=/offstage/artifacts

# World-writable so the lane can pass `--user $(id -u):$(id -g)` on Linux (which
# it does, to keep artifacts owned by the human rather than by root) and the run
# still has somewhere to write.
RUN mkdir -p /ms-playwright /offstage/artifacts /workspace /tmp/offstage \
    && chmod 1777 /ms-playwright /offstage /offstage/artifacts /tmp/offstage

# Fluxbox configuration. Without this the window manager tries to paint a JPEG
# wallpaper, fails inside a container, and throws an xmessage error dialog into
# every screenshot, one that also steals focus from the browser under test.
# See the comment block in fluxbox-init for the full story.
#
# The style is *derived* from Debian's rather than vendored: the sed keeps every
# decoration, colour and font of the stock theme and neutralises only the two
# background lines, so the desktop still looks like a real one.
COPY fluxbox-init /etc/X11/fluxbox/init
RUN mkdir -p /etc/offstage/fluxbox \
    && sed -e 's|^background:.*|background: none|' \
           -e 's|^background\.pixmap:.*|! wallpaper removed by offstage|' \
           /usr/share/fluxbox/styles/Squared_for_Debian/theme.cfg \
       > /etc/offstage/fluxbox/style \
    && grep -q '^background: none$' /etc/offstage/fluxbox/style \
    && ! grep -q 'debian-squared' /etc/offstage/fluxbox/style

COPY offstage-entrypoint.sh /usr/local/bin/offstage-entrypoint
RUN chmod 0755 /usr/local/bin/offstage-entrypoint

WORKDIR /workspace

# The entrypoint brings up Xvfb + fluxbox, exports DISPLAY, runs whatever argv it
# is handed, screenshots the framebuffer, and exits with the command's own code.
ENTRYPOINT ["/usr/local/bin/offstage-entrypoint"]
CMD ["xdpyinfo"]
