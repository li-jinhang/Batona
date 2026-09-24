# iOS PWA 实现规格

## Problem Statement

Batona 当前通过 Android 客户端提供手机端远程控制能力，iPhone 用户没有相同的入口。用户希望免去 App Store 上架与 Apple Developer Program，用可添加到主屏幕的 PWA 提供当前 Android 中已实际可用的 DSH 与 Codex 工作流程，并把入口加入 DSH Link 下载页。

## Solution

在现有 HTTPS 网站下发布可安装的 PWA。用户先从 Safari 将 PWA 添加到 iPhone 主屏幕，再通过二维码或手动配对码向电脑申请授权。PWA 复用 Batona Hosted Gateway 的账号设备授权、HTTP API 与 WebSocket 协议，提供 Android 当前可用 DSH/Codex 流程的浏览器界面。

首发包括用户主动开启的 Web Push，仅提醒等待审批、等待回答、完成或失败等事件，不包含消息正文。断网时只显示缓存的 PWA 应用界面外壳；会话数据不离线展示，任何远程操作都必须联网。

## User Stories

1. As an iPhone user, I want to find an iOS PWA entry in the DSH Link downloads section, so that I can start using Batona without searching for an App Store listing.
2. As an iPhone user, I want clear Safari installation instructions, so that I can add the PWA to my Home Screen and launch it as a web app.
3. As a new mobile user, I want to install the PWA before pairing, so that the phone identity and authorization are created in the storage context that will actually run the PWA.
4. As a mobile user, I want to scan the QR code shown by the approved PC, so that I can request access without typing a code.
5. As a mobile user whose camera is unavailable or denied, I want to enter the pairing code manually, so that I can still request access.
6. As a PC user, I want to review and explicitly approve each phone pairing request, so that scanning or entering a code alone never grants access.
7. As an account owner whose Android phone already occupies the mobile-device slot, I want a clear explanation when PWA pairing is rejected, so that I know I must unbind the old phone from the PC first.
8. As an account owner switching from Android to iPhone, I want the old phone's authorization revoked when I unbind it, so that only the newly paired phone remains authorized.
9. As a paired iPhone user, I want my authorization to survive normal app closure and network interruption, so that I do not need to pair again after every restart.
10. As a paired user whose device authorization has been revoked, I want the PWA to return to the pairing flow, so that it does not continue to display stale access as valid.
11. As a mobile user, I want DSH and Codex to remain separate destinations with independent session state, so that switching backends does not mix their workspaces or conversations.
12. As a DSH or Codex user, I want to browse my available workspaces and their sessions, so that I can choose the desktop context I need.
13. As a mobile user, I want each workspace to show its five newest sessions by default and let me request older sessions, so that the initial list stays manageable while older work remains accessible.
14. As a mobile user, I want to resume a session and view its available history, so that I can continue work from the computer.
15. As a mobile user, I want to create a session through the backend's currently supported flow using an available workspace, so that the PC starts work in the selected context.
16. As a mobile user, I want to browse PC directories when creating or registering a workspace, so that I can select a real desktop path without the phone gaining direct filesystem access.
17. As a mobile user, I want workspace removal to leave files on the PC untouched, so that removing a workspace association cannot delete user data.
18. As a mobile user, I want to send text requests and retain an unsent draft after a network error, so that a temporary connection failure does not lose my input.
19. As a mobile user, I want to see assistant output and redacted tool activity as it arrives, so that I can follow the desktop session without screen mirroring.
20. As a mobile user, I want to cancel an active turn when the backend supports cancellation, so that I can stop work that is no longer needed.
21. As a mobile user, I want to allow an approval once or reject it, so that a PC-side request can be resolved from the phone without changing the PC's permission policy.
22. As a mobile user, I want to answer a question with a listed option or custom text, or skip it when supported, so that the desktop session can continue with my response.
23. As a mobile user, I want to rename or archive a session when those actions are supported, so that I can organize work without implying that archived data was deleted from the PC.
24. As a mobile user, I want to view the model choices advertised by the connected PC and select an available model, so that the phone does not invent unsupported model options.
25. As a Codex user, I want to choose a supported reasoning strength and PC-provided permission profile, so that the selected session settings match the connected PC's actual capabilities.
26. As a Codex user, I want a separate confirmation before choosing a fully permissive profile, so that a consequential permission change cannot happen through an accidental tap.
27. As a mobile user, I want unsupported capabilities to be disabled or explained, so that the interface does not imply that an incomplete desktop integration is available.
28. As a mobile user, I want the PWA to reconnect and reconcile its view with the PC after network recovery, so that its state comes from the authoritative desktop session.
29. As an offline iPhone user, I want the previously cached PWA interface shell to open, so that I can see the app entry and understand that the service is offline.
30. As an offline iPhone user, I want session lists, conversation history, and remote-action controls to remain unavailable, so that stale information is not presented as current and no operation is silently queued.
31. As a paired user, I want an explicit “Enable notifications” action after pairing, so that the browser asks for notification permission only after I request it.
32. As a user who denies notification permission, I want the PWA to explain the disabled state and preserve an in-app way to try again where iOS permits it, so that declining once does not strand the rest of the app.
33. As a user with notifications enabled, I want visible system notifications only for waiting approval, waiting answer, completion, and failure, so that alerts are useful without exposing conversation content.
34. As a user opening a push notification, I want the PWA to reconnect and refresh from the PC's authoritative state, so that a notification is only an alert and never a substitute for the session state.
35. As a user signing out, I want the server to confirm revocation before local authorization is cleared, so that the PWA does not report a successful sign-out when the server still accepts the device.
36. As a user whose browser storage was cleared or evicted, I want a clear recovery path that explains the required PC unbind and re-pair, so that I can recover from lost device credentials.
37. As an iPhone user on iOS 16.4 or later, I want the installed PWA and Web Push flow to work as documented, so that the complete PWA experience has an explicit platform baseline.
38. As a user on an earlier iOS version, I want the site to avoid promising full push support, so that I understand the supported feature boundary before pairing.

## Implementation Decisions

- Build a browser client as a separate product surface. Do not wrap the Android app in a native shell or require App Store distribution.
- Publish the static PWA under the existing DSH Link HTTPS origin. Keep the PWA's Service Worker scope within its own subpath; use the existing same-origin Hosted Gateway HTTP and WebSocket endpoints rather than introducing a cross-origin client.
- Add a distinct iOS PWA card and installation steps to the DSH Link downloads section. The card points to the PWA entry URL.
- Match DSH and Codex flows that are currently usable and verified through the existing Android/PC/Gateway system. Use PC-provided capability/profile information as the authority for controls.
- Preserve the current one-phone-per-account binding rule. A different phone identity is rejected while the slot is occupied. The user must unbind the old phone from the PC before pairing the new one; do not add automatic takeover.
- Require Home Screen installation before pairing. Safari and the installed Home Screen web app have separate site storage, and iOS Web Push is available to installed Home Screen web apps rather than ordinary Safari tabs.
- Persist the browser device identity and authorization in PWA-origin IndexedDB so ordinary restarts retain pairing. Do not place credentials in URLs, Service Worker caches, logs, or notification payloads. Apply a restrictive Content Security Policy and avoid third-party scripts. This is not equivalent to Android hardware-backed Keystore protection; browser storage may be cleared or evicted, in which case the user follows PC unbind and re-pair recovery.
- Cache only the static application shell and required versioned assets. Do not cache authenticated API responses, workspaces, session data, event history, or action requests. Do not queue writes while offline. Treat cached shell storage as best-effort and rebuildable.
- Keep the existing Gateway as the authority for pairing, device authorization, PC capabilities, sessions, and actions. Add only the subscription lifecycle and server-side Web Push delivery required for this PWA release. A valid push subscription is associated with the currently authorized phone and must be removed or invalidated on unbind, revoke, and sign-out.
- Request notification permission only in response to the user's explicit enable-notifications action after pairing. Each push must result in a visible notification and may contain only a non-sensitive event category; opening it returns to the PWA, which reconnects and refreshes authoritative state.
- Support the full installed PWA and Web Push experience from iOS 16.4. Earlier iOS versions are not promised the full feature set; the page must state this boundary.
- Continue to represent Claude Code as unavailable because the Android entry is only a placeholder. Do not claim that incomplete Codex native-desktop control is supported merely because related UI controls exist.
- No account registration, password/TOTP sign-in, image input, voice input, or phone-side Agent execution is added; the PWA follows the current hosted PC-approved pairing model and text-input boundary.

## Testing Decisions

- A good test exercises observable user behavior through the highest practical seam and does not assert private component structure, CSS implementation details, or Gateway storage layout.
- Use one browser end-to-end seam: run the built PWA in a real browser against an isolated Hosted Gateway fixture and simulated PC tunnel. Cover pairing approval and occupied-slot behavior, DSH/Codex navigation and available session flows, action/response behavior, push subscription lifecycle, sign-out/revoke, shell-only offline startup, and the absence of offline data/actions/queues.
- Test permission-denied and permission-enabled behavior through browser-visible outcomes; verify that push payloads contain only allowed event categories and that opening a notification triggers a state refresh rather than carrying session content.
- Prior art is the existing isolated Android/Gateway fixture, Hosted Gateway access/isolation tests, Gateway DSH end-to-end checks, and Android UI tests. Reuse the isolated PC/Gateway behavior where practical rather than building multiple independent protocol fakes.
- Release qualification on a real iPhone must verify Safari installation into the Home Screen, standalone launch, storage separation from Safari, install-before-pair behavior, QR and manual pairing, safe-area/keyboard layout, offline shell after first load, service-worker update, iOS 16.4+ permission flow, actual system Web Push delivery, notification click-through, permission denial/recovery, and cleanup after unbind/sign-out. Automated browser tests do not substitute for this platform-specific acceptance.
- Do not use production accounts or real Agent sessions in automated tests. Avoid triggering paid model calls in routine CI.

## Out of Scope

- Native iOS application, App Store listing, Apple signing, or Apple Developer Program membership.
- Simultaneous Android and iPhone pairing, multiple phone slots, or automatic replacement of an occupied phone slot.
- Offline session list/history, offline Agent operation, approval or answer submission while offline, and delayed replay of queued requests.
- Claude Code backend support and completion of unverified Codex native-desktop integration paths.
- Image, audio, or file upload from the phone; Android's current mobile request flow is text-only.
- Phone-side Agent execution, access to PC files outside PC-mediated directory browsing, screen mirroring, or a separate server-side copy of desktop session state.
- Guaranteed background WebSocket connectivity or guaranteed push delivery. Push is an attention signal; the PC remains the state authority and the PWA must reconcile after opening.
- Full feature support on iOS versions earlier than 16.4.

## Further Notes

- Approved source directory: D:/_Projects/26-009DSHplugin/product/pwa.
- Approved public entry URL: https://117.72.10.87/projects/dsh-link/pwa/.
- The PWA source belongs to the Batona product repository while its built static files and download card are published through the separate DSH Link static-site project. Updates to the downloads page must preserve existing work and update the site's release-notice data according to its repository conventions.
- The older platform-research document remains the source of platform facts. Where its earlier recommendations differ from this accepted implementation scope, this implementation spec takes precedence: use the selected DSH Link static route, cache only the shell, and include Web Push in the first release.
- Before production release, re-check the live TLS certificate and verify that the Gateway host can reach Apple's Web Push service. Deployment must retain and merge existing server/site data and preserve unrelated uncommitted changes in both repositories.
- No issue-tracker integration or triage-label vocabulary was present when this spec was prepared. The to-spec workflow requires `/setup-matt-pocock-skills` before publishing this document as an issue with the `ready-for-agent` label.
