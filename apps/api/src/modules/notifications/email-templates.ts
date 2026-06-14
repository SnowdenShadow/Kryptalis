/**
 * Inline-CSS HTML email scaffolding for DockControl transactional mail.
 *
 * Why inline CSS only? Outlook/Gmail/Apple Mail strip <style> blocks
 * inconsistently — inline is the only reliably portable styling. We also
 * skip remote images entirely (no tracking-pixel ambiguity, no broken
 * "show images" prompts) and render the brand mark as a CSS-styled box
 * containing the letter K.
 *
 * Dark-mode handling: we set both `color-scheme: light dark` and use a
 * neutral palette that reads correctly under either mode. The single
 * <style> block is allowed only for the @media (prefers-color-scheme)
 * override of the body background — Gmail iOS / Apple Mail respect it,
 * Outlook ignores it (and that's fine, Outlook stays light).
 */

export interface RenderEmailOpts {
  title: string;
  body: string; // raw HTML body (caller must pre-escape user content)
  ctaLabel?: string;
  ctaUrl?: string;
  preheader?: string; // hidden preview text shown by most clients
}

/** HTML-escape a string for safe interpolation into the template. */
export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderEmail({
  title,
  body,
  ctaLabel,
  ctaUrl,
  preheader,
}: RenderEmailOpts): string {
  const cta =
    ctaLabel && ctaUrl
      ? `
      <tr>
        <td align="center" style="padding:24px 0 8px 0;">
          <a href="${escapeHtml(ctaUrl)}"
             style="display:inline-block;background:#7c5cff;color:#ffffff;
                    font-weight:600;font-size:15px;line-height:1;
                    padding:14px 28px;border-radius:8px;
                    text-decoration:none;font-family:Inter,system-ui,sans-serif;">
            ${escapeHtml(ctaLabel)}
          </a>
        </td>
      </tr>`
      : '';

  const preheaderHtml = preheader
    ? `<div style="display:none;font-size:1px;color:#0b0b10;line-height:1px;
                    max-height:0;max-width:0;opacity:0;overflow:hidden;">
         ${escapeHtml(preheader)}
       </div>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <title>${escapeHtml(title)}</title>
    <style>
      @media (prefers-color-scheme: dark) {
        body, .bg { background:#0b0b10 !important; }
        .card { background:#15151d !important; border-color:#26262f !important; }
        .text { color:#e6e6ef !important; }
        .muted { color:#9a9aa8 !important; }
        .divider { border-color:#26262f !important; }
      }
    </style>
  </head>
  <body class="bg" style="margin:0;padding:0;background:#f4f4f7;
                          font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;">
    ${preheaderHtml}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg"
           style="background:#f4f4f7;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"
                 class="card"
                 style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e5e5ec;
                        border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:24px 28px 8px 28px;" align="left">
                <div style="display:inline-block;width:36px;height:36px;border-radius:9px;
                            background:linear-gradient(135deg,#7c5cff 0%,#5b3df0 100%);
                            color:#ffffff;font-weight:800;font-size:20px;line-height:36px;
                            text-align:center;font-family:Inter,system-ui,sans-serif;">K</div>
                <span class="muted"
                      style="margin-left:10px;color:#6b6b78;font-weight:600;
                             font-size:14px;letter-spacing:0.3px;vertical-align:middle;">
                  DockControl
                </span>
              </td>
            </tr>
            <tr>
              <td class="text"
                  style="padding:8px 28px 0 28px;color:#0b0b10;font-size:20px;font-weight:700;line-height:1.3;">
                ${escapeHtml(title)}
              </td>
            </tr>
            <tr>
              <td class="text"
                  style="padding:12px 28px 0 28px;color:#2a2a36;font-size:15px;line-height:1.55;">
                ${body}
              </td>
            </tr>
            ${cta}
            <tr>
              <td style="padding:24px 28px 0 28px;">
                <hr class="divider" style="border:none;border-top:1px solid #ececf2;margin:0;" />
              </td>
            </tr>
            <tr>
              <td class="muted"
                  style="padding:14px 28px 24px 28px;color:#8a8a99;font-size:12px;line-height:1.5;">
                You're receiving this email from your DockControl instance. If you
                didn't expect it, you can safely ignore this message.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
