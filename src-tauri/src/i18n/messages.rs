//! Sentences the backend sends to the UI (toasts, notices, error text shown
//! as they come). Each takes the language first, so a test can ask for either
//! language without touching the global one; callers pass
//! `current_ui_language()`. The product name is always `APP_NAME`.
//!
//! English is upstream's wording (with the product name from `APP_NAME`).
//! Not here: the Auto-detect refusals and language hints (the frontend
//! matches them word for word), prompts for the model, log lines.

use std::fmt::Display;

use super::{UiLanguage, APP_NAME};

fn pick(lang: UiLanguage, en: String, zh: String) -> String {
    match lang {
        UiLanguage::En => en,
        UiLanguage::ZhCn => zh,
    }
}

// ---- audio capture (audio/capture_supervisor.rs, audio/mod.rs) ----

pub fn mic_stand_in(lang: UiLanguage, now: &str) -> String {
    pick(
        lang,
        format!("Your microphone disconnected. Using {now} for now."),
        format!("你的麦克风已断开，暂时改用 {now}。"),
    )
}

pub fn mic_now(lang: UiLanguage, now: &str) -> String {
    pick(
        lang,
        format!("Now using {now} as your microphone."),
        format!("现在使用 {now} 作为你的麦克风。"),
    )
}

pub fn output_stand_in(lang: UiLanguage, now: &str) -> String {
    pick(
        lang,
        format!("The speakers or headphones you hear the call on disconnected. Listening on {now} instead."),
        format!("你收听通话的扬声器或耳机已断开，改为从 {now} 收听。"),
    )
}

pub fn output_now(lang: UiLanguage, now: &str) -> String {
    pick(
        lang,
        format!("Now listening on {now} for the other side."),
        format!("现在通过 {now} 收听对方。"),
    )
}

pub fn them_now(lang: UiLanguage, now: &str) -> String {
    pick(
        lang,
        format!("Now capturing the other side from {now}."),
        format!("现在从 {now} 采集对方的声音。"),
    )
}

pub fn dual_now(lang: UiLanguage, now: &str) -> String {
    pick(
        lang,
        format!("Now using {now} for you and the other side."),
        format!("现在使用 {now} 采集你和对方的声音。"),
    )
}

pub fn mic_back(lang: UiLanguage, device: &str) -> String {
    pick(
        lang,
        format!("{device} is back as your microphone."),
        format!("{device} 已恢复，继续作为你的麦克风。"),
    )
}

pub fn output_back(lang: UiLanguage, device: &str) -> String {
    pick(
        lang,
        format!("{device} is back. Listening for the other side again."),
        format!("{device} 已恢复，重新收听对方。"),
    )
}

pub fn them_back(lang: UiLanguage, device: &str) -> String {
    pick(
        lang,
        format!("{device} is back. Capturing the other side again."),
        format!("{device} 已恢复，重新采集对方的声音。"),
    )
}

pub fn dual_back(lang: UiLanguage, device: &str) -> String {
    pick(
        lang,
        format!("{device} is back for you and the other side."),
        format!("{device} 已恢复，继续用于你和对方。"),
    )
}

/// `system` is "macOS" or "Windows".
pub fn privacy_blocks_output(lang: UiLanguage, system: &str) -> String {
    let app = APP_NAME;
    pick(
        lang,
        format!("{system} privacy settings are blocking {app} from capturing the call's audio. Allow it in {system} settings and {app} reconnects."),
        format!("{system} 的隐私设置正在阻止 {app} 采集通话音频。请在 {system} 设置中允许后，{app} 会自动重新连接。"),
    )
}

pub fn privacy_blocks_mic(lang: UiLanguage, system: &str) -> String {
    let app = APP_NAME;
    pick(
        lang,
        format!("{system} privacy settings are blocking your microphone. Allow microphone access for {app} in {system} settings and {app} reconnects."),
        format!("{system} 的隐私设置正在阻止使用你的麦克风。请在 {system} 设置中允许 {app} 使用麦克风，{app} 会自动重新连接。"),
    )
}

pub fn mic_lost(lang: UiLanguage) -> String {
    let app = APP_NAME;
    pick(
        lang,
        format!("Your microphone disconnected. {app} reconnects it when it's back, or pick another microphone in Audio & Devices."),
        format!("你的麦克风已断开。它恢复后 {app} 会自动重新连接，也可以在“音频与设备”中另选一个麦克风。"),
    )
}

pub fn output_lost(lang: UiLanguage) -> String {
    let app = APP_NAME;
    pick(
        lang,
        format!("The speakers or headphones you hear the call on disconnected. {app} reconnects them when they're back, or pick another device in Audio & Devices."),
        format!("你收听通话的扬声器或耳机已断开。它们恢复后 {app} 会自动重新连接，也可以在“音频与设备”中另选设备。"),
    )
}

pub fn them_lost(lang: UiLanguage) -> String {
    let app = APP_NAME;
    pick(
        lang,
        format!("The device the other side comes in on disconnected. {app} reconnects it when it's back, or pick another device in Audio & Devices."),
        format!("对方声音所用的设备已断开。它恢复后 {app} 会自动重新连接，也可以在“音频与设备”中另选设备。"),
    )
}

pub fn dual_lost(lang: UiLanguage) -> String {
    let app = APP_NAME;
    pick(
        lang,
        format!("Your shared input device disconnected. {app} reconnects it when it's back, or pick another device in Audio & Devices."),
        format!("你和对方共用的输入设备已断开。它恢复后 {app} 会自动重新连接，也可以在“音频与设备”中另选设备。"),
    )
}

pub fn mic_fallback(lang: UiLanguage, device_id: &str) -> String {
    let app = APP_NAME;
    pick(
        lang,
        format!("Your microphone '{device_id}' isn't available, so {app} is using the default microphone."),
        format!("你的麦克风“{device_id}”不可用，{app} 正在使用默认麦克风。"),
    )
}

pub fn output_fallback(lang: UiLanguage, device_id: &str) -> String {
    let app = APP_NAME;
    pick(
        lang,
        format!("The other side's device '{device_id}' isn't available, so {app} is capturing your default output instead."),
        format!("对方使用的设备“{device_id}”不可用，{app} 改为采集你的默认输出。"),
    )
}

// ---- personal sources: commands (commands/sources_commands.rs) ----

pub fn credential_save_failed(lang: UiLanguage, e: impl Display) -> String {
    pick(
        lang,
        format!("Couldn't save a secret in the system credential store: {e}"),
        format!("无法把密钥保存到系统凭据库：{e}"),
    )
}

pub fn folder_inspect_failed(lang: UiLanguage, e: impl Display) -> String {
    pick(lang, format!("Couldn't look at the folder: {e}"), format!("无法查看这个文件夹：{e}"))
}

pub fn sources_unreadable(lang: UiLanguage) -> String {
    pick(lang, "Couldn't read your sources".into(), "无法读取你的个人资料来源".into())
}

pub fn file_outside_folders(lang: UiLanguage) -> String {
    pick(
        lang,
        "That file isn't inside one of your enabled notes folders.".into(),
        "这个文件不在你已启用的任何笔记文件夹里。".into(),
    )
}

pub fn only_notes_open(lang: UiLanguage) -> String {
    let app = APP_NAME;
    pick(
        lang,
        format!("{app} only opens notes and documents from here, not other kinds of file."),
        format!("{app} 在这里只会打开笔记和文档，不会打开其他类型的文件。"),
    )
}

pub fn open_failed(lang: UiLanguage, path: &str, e: impl Display) -> String {
    pick(lang, format!("Couldn't open {path}: {e}"), format!("无法打开 {path}：{e}"))
}

pub fn claude_code_no_server(lang: UiLanguage, name: &str) -> String {
    pick(
        lang,
        format!("Claude Code has no server named \"{name}\""),
        format!("Claude Code 里没有名为“{name}”的服务器"),
    )
}

pub fn claude_code_config_unreadable(lang: UiLanguage, e: impl Display) -> String {
    pick(
        lang,
        format!("Couldn't read Claude Code's config: {e}"),
        format!("无法读取 Claude Code 的配置：{e}"),
    )
}

pub fn claude_code_config_missing(lang: UiLanguage) -> String {
    pick(
        lang,
        "Claude Code's config wasn't found on this PC".into(),
        "在这台电脑上找不到 Claude Code 的配置".into(),
    )
}

pub fn server_needs_name(lang: UiLanguage) -> String {
    pick(lang, "Give the server a name".into(), "请给服务器起个名字".into())
}

pub fn server_key_invalid(lang: UiLanguage) -> String {
    pick(lang, "This server's key isn't valid".into(), "这个服务器的标识无效".into())
}

pub fn server_needs_command(lang: UiLanguage) -> String {
    pick(
        lang,
        "Enter the command that starts the server".into(),
        "请输入启动服务器的命令".into(),
    )
}

pub fn url_needs_scheme(lang: UiLanguage) -> String {
    pick(
        lang,
        "The URL must start with http:// or https://".into(),
        "URL 必须以 http:// 或 https:// 开头".into(),
    )
}

pub fn header_needs_name(lang: UiLanguage) -> String {
    pick(lang, "A header needs a name".into(), "请求头需要名称".into())
}

pub fn header_listed_twice(lang: UiLanguage, name: &str) -> String {
    pick(lang, format!("The {name} header is listed twice"), format!("请求头 {name} 重复了"))
}

pub fn env_needs_name(lang: UiLanguage) -> String {
    pick(lang, "An environment variable needs a name".into(), "环境变量需要名称".into())
}

pub fn env_name_invalid(lang: UiLanguage, name: &str) -> String {
    pick(
        lang,
        format!("\"{name}\" isn't a valid environment variable name"),
        format!("“{name}”不是有效的环境变量名"),
    )
}

pub fn env_listed_twice(lang: UiLanguage, name: &str) -> String {
    pick(lang, format!("{name} is listed twice"), format!("{name} 重复了"))
}

pub fn server_not_saved_edit(lang: UiLanguage) -> String {
    let app = APP_NAME;
    pick(
        lang,
        format!("{app} doesn't have this server saved yet. Save your sources first, then edit it."),
        format!("{app} 还没有保存这个服务器。请先保存你的个人资料来源，再编辑它。"),
    )
}

pub fn server_not_saved(lang: UiLanguage) -> String {
    let app = APP_NAME;
    pick(
        lang,
        format!("{app} doesn't have this server saved yet. Save your sources first."),
        format!("{app} 还没有保存这个服务器。请先保存你的个人资料来源。"),
    )
}

pub fn server_has_invalid_key(lang: UiLanguage, label: &str) -> String {
    pick(
        lang,
        format!("The server \"{label}\" has an invalid key"),
        format!("服务器“{label}”的标识无效"),
    )
}

pub fn servers_share_key(lang: UiLanguage, key: &str) -> String {
    pick(
        lang,
        format!("Two servers share the key \"{key}\""),
        format!("有两个服务器使用了相同的标识“{key}”"),
    )
}

// ---- checking a tool server (llm/cli_agent/mcp_check.rs, mcp_diagnose.rs) ----

pub fn mcp_failed_to_start(lang: UiLanguage) -> String {
    pick(
        lang,
        "The server failed to start. Check its command, arguments and sign-in values.".into(),
        "服务器启动失败。请检查它的命令、参数和登录信息。".into(),
    )
}

pub fn mcp_needs_sign_in(lang: UiLanguage) -> String {
    let app = APP_NAME;
    pick(
        lang,
        format!("The server needs a sign-in, which {app} doesn't support yet."),
        format!("该服务器需要登录，{app} 暂不支持。"),
    )
}

pub fn mcp_pending(lang: UiLanguage) -> String {
    pick(
        lang,
        "The server didn't answer in time. A first run can take a while to download; try Check again.".into(),
        "服务器没有及时响应。首次运行可能要下载一阵子，请再点一次“检查”。".into(),
    )
}

pub fn mcp_other_status(lang: UiLanguage, status: &str) -> String {
    pick(
        lang,
        format!("The server didn't finish connecting (status: {status})."),
        format!("服务器没能完成连接（状态：{status}）。"),
    )
}

pub fn mcp_not_started(lang: UiLanguage) -> String {
    pick(lang, "The server didn't start.".into(), "服务器没有启动。".into())
}

pub fn mcp_cli_missing(lang: UiLanguage) -> String {
    pick(
        lang,
        "Claude CLI isn't installed, so the server can't be checked.".into(),
        "没有安装 Claude CLI，无法检查这个服务器。".into(),
    )
}

pub fn mcp_timeout(lang: UiLanguage) -> String {
    pick(lang, "The server took too long to start.".into(), "服务器启动用了太久。".into())
}

pub fn diagnose_cant_start(lang: UiLanguage, command: &str, e: impl Display) -> String {
    pick(
        lang,
        format!("It couldn't start {command}: {e}."),
        format!("无法启动 {command}：{e}。"),
    )
}

/// ` (exit code 1)`, or nothing.
pub fn diagnose_exit_code(lang: UiLanguage, code: i32) -> String {
    pick(lang, format!(" (exit code {code})"), format!("（退出码 {code}）"))
}

pub fn diagnose_stopped_with_line(lang: UiLanguage, code: &str, line: &str) -> String {
    pick(
        lang,
        format!("It stopped right away{code}. Its last message: {line}"),
        format!("它立刻停止了{code}。它的最后一条消息：{line}"),
    )
}

pub fn diagnose_stopped_silent(lang: UiLanguage, code: &str) -> String {
    pick(
        lang,
        format!("It stopped right away{code}, without saying why."),
        format!("它立刻停止了{code}，没有说明原因。"),
    )
}

pub fn diagnose_last_message(lang: UiLanguage, line: &str) -> String {
    pick(lang, format!("Its last message: {line}"), format!("它的最后一条消息：{line}"))
}

/// `reason` is ` Not Found` or empty.
pub fn diagnose_http_status(lang: UiLanguage, status: u16, reason: &str) -> String {
    pick(
        lang,
        format!("The server answered {status}{reason}."),
        format!("服务器返回了 {status}{reason}。"),
    )
}

pub fn diagnose_unreachable(lang: UiLanguage, text: &str) -> String {
    pick(lang, format!("It couldn't be reached: {text}"), format!("无法连接到它：{text}"))
}

// ---- personal sources: folders, notices, activity ----

pub fn problem_whole_drive(lang: UiLanguage) -> String {
    pick(
        lang,
        "A whole drive can't be a notes folder. Choose the folder that holds your notes.".into(),
        "不能把整个磁盘当作笔记文件夹。请选择存放笔记的文件夹。".into(),
    )
}

pub fn problem_private_files(lang: UiLanguage) -> String {
    let app = APP_NAME;
    pick(
        lang,
        format!("This folder holds {app}'s private files, so it can't be a notes folder."),
        format!("这个文件夹里有 {app} 的私有文件，不能作为笔记文件夹。"),
    )
}

pub fn problem_user_folder(lang: UiLanguage) -> String {
    pick(
        lang,
        "Your whole user folder can't be a notes folder. Choose the folder that holds your notes.".into(),
        "不能把整个用户文件夹当作笔记文件夹。请选择存放笔记的文件夹。".into(),
    )
}

pub fn problem_contains_user_folder(lang: UiLanguage) -> String {
    pick(
        lang,
        "This folder contains your whole user folder, so it can't be a notes folder.".into(),
        "这个文件夹包含整个用户文件夹，不能作为笔记文件夹。".into(),
    )
}

pub fn problem_sign_in_files(lang: UiLanguage) -> String {
    pick(
        lang,
        "This folder holds your account's sign-in files, so it can't be a notes folder.".into(),
        "这个文件夹里有你账户的登录文件，不能作为笔记文件夹。".into(),
    )
}

/// The server names as a list: "A, B and C".
pub fn name_list(lang: UiLanguage, names: &[&str]) -> String {
    match names.split_last() {
        Some((last, rest)) if !rest.is_empty() => match lang {
            UiLanguage::En => format!("{} and {last}", rest.join(", ")),
            UiLanguage::ZhCn => format!("{} 和 {last}", rest.join("、")),
        },
        _ => names.join(""),
    }
}

pub fn servers_didnt_start(lang: UiLanguage, list: &str, many: bool) -> String {
    pick(
        lang,
        if many {
            format!("{list} didn't start, so their tools aren't available")
        } else {
            format!("{list} didn't start, so its tools aren't available")
        },
        if many {
            format!("{list} 没有启动，所以它们的工具不可用")
        } else {
            format!("{list} 没有启动，所以它的工具不可用")
        },
    )
}

pub fn left_out(lang: UiLanguage, reasons: &str) -> String {
    pick(lang, format!("Left out: {reasons}"), format!("已略过：{reasons}"))
}

/// Joins the parts of a degraded-sources notice.
pub fn notice_joiner(lang: UiLanguage) -> &'static str {
    match lang {
        UiLanguage::En => ". ",
        UiLanguage::ZhCn => "。",
    }
}

pub fn searching_notes(lang: UiLanguage, pattern: &str) -> String {
    pick(lang, format!("Searching notes for '{pattern}'"), format!("正在搜索笔记：“{pattern}”"))
}

pub fn finding_notes(lang: UiLanguage, pattern: &str) -> String {
    pick(lang, format!("Looking for notes named '{pattern}'"), format!("正在查找名为“{pattern}”的笔记"))
}

pub fn reading_a_note(lang: UiLanguage) -> String {
    pick(lang, "Reading a note".into(), "正在阅读笔记".into())
}

pub fn reading_note(lang: UiLanguage, name: &str) -> String {
    pick(lang, format!("Reading {name}"), format!("正在阅读 {name}"))
}

pub fn using_tool(lang: UiLanguage, name: &str) -> String {
    pick(lang, format!("Using {name}"), format!("正在使用 {name}"))
}

pub fn sources_not_loaded(lang: UiLanguage, reason: &str) -> String {
    pick(
        lang,
        format!("Your sources couldn't be loaded, so this answer didn't use them. {reason}"),
        format!("你的个人资料来源未能加载，所以这条回答没有用到它们。{reason}"),
    )
}

pub fn sources_not_loaded_retry(lang: UiLanguage, reason: &str, when: &str) -> String {
    pick(
        lang,
        format!("Your sources couldn't be loaded, so this answer didn't use them. {reason}. {when}"),
        format!("你的个人资料来源未能加载，所以这条回答没有用到它们。{reason}。{when}"),
    )
}

pub fn retry_now(lang: UiLanguage) -> String {
    pick(lang, "Trying again now.".into(), "现在重试。".into())
}

pub fn retry_soon(lang: UiLanguage) -> String {
    pick(lang, "Trying again in under a minute.".into(), "不到一分钟后重试。".into())
}

pub fn retry_in_minutes(lang: UiLanguage, minutes: u64) -> String {
    pick(lang, format!("Trying again in {minutes} min."), format!("{minutes} 分钟后重试。"))
}

// ---- images and screen capture ----

pub fn images_need_claude(lang: UiLanguage) -> String {
    pick(
        lang,
        "Images work only with Claude (subscription). Choose it for this action in Settings → AI Models, or remove the image and ask again.".into(),
        "图片仅支持 Claude（订阅）。请在“设置 → AI 模型”中为这个动作选择它，或移除图片后重新提问。".into(),
    )
}

pub fn claude_cant_read_images(lang: UiLanguage) -> String {
    pick(
        lang,
        "Claude can't read images right now. Try again in a moment, or remove the image and ask again.".into(),
        "Claude 现在无法读取图片。请稍后再试，或移除图片后重新提问。".into(),
    )
}

pub fn claude_rejected_image(lang: UiLanguage) -> String {
    pick(
        lang,
        "Claude couldn't use the attached image. Remove it or paste a smaller one, then send again.".into(),
        "Claude 无法使用附加的图片。请移除它或粘贴较小的图片，然后重新发送。".into(),
    )
}

pub fn too_many_images(lang: UiLanguage, max: usize) -> String {
    pick(
        lang,
        format!("You can attach up to {max} images"),
        format!("最多可以附加 {max} 张图片"),
    )
}

pub fn image_type_refused(lang: UiLanguage) -> String {
    pick(
        lang,
        "Only PNG, JPEG, GIF and WebP images can be attached".into(),
        "只能附加 PNG、JPEG、GIF 和 WebP 图片".into(),
    )
}

pub fn image_empty(lang: UiLanguage) -> String {
    pick(lang, "An attached image is empty".into(), "附加的图片是空的".into())
}

pub fn image_too_large(lang: UiLanguage) -> String {
    pick(
        lang,
        "An attached image is larger than 5 MB".into(),
        "附加的图片超过了 5 MB".into(),
    )
}

pub fn capture_failed(lang: UiLanguage) -> String {
    pick(lang, "Couldn't capture the screen".into(), "无法截取屏幕".into())
}

pub fn capture_black(lang: UiLanguage) -> String {
    pick(
        lang,
        "The screen came out black. It may be locked or showing protected content.".into(),
        "截到的屏幕是黑的。可能已锁屏，或正在显示受保护的内容。".into(),
    )
}

pub fn capture_only_overlay(lang: UiLanguage) -> String {
    pick(
        lang,
        "Screen capture is only available from the meeting overlay".into(),
        "只能在会议悬浮窗中截屏".into(),
    )
}

pub fn capture_only_in_meeting(lang: UiLanguage) -> String {
    pick(
        lang,
        "Screen capture is only available during a meeting".into(),
        "只能在会议进行中截屏".into(),
    )
}

pub fn capture_windows_only(lang: UiLanguage) -> String {
    pick(
        lang,
        "Capturing the screen is only available on Windows for now".into(),
        "目前只有 Windows 支持截取屏幕".into(),
    )
}

// ---- pasted Claude Code / MCP JSON (sources/mcp_json.rs) ----

pub fn json_invalid(lang: UiLanguage, e: impl Display) -> String {
    pick(lang, format!("This is not valid JSON ({e})"), format!("这不是有效的 JSON（{e}）"))
}

pub fn json_expected_object(lang: UiLanguage) -> String {
    pick(
        lang,
        "Expected a JSON object with your servers".into(),
        "需要一个包含你的服务器的 JSON 对象".into(),
    )
}

pub fn json_no_servers(lang: UiLanguage) -> String {
    pick(lang, "No servers found in this JSON".into(), "这段 JSON 里没有找到服务器".into())
}

pub fn claude_code_config_invalid(lang: UiLanguage, e: impl Display) -> String {
    pick(
        lang,
        format!("Claude Code's config is not valid JSON ({e})"),
        format!("Claude Code 的配置不是有效的 JSON（{e}）"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use UiLanguage::{En, ZhCn};

    fn has_cjk(s: &str) -> bool {
        s.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
    }

    #[test]
    fn capture_notices_use_the_product_name_in_both_languages() {
        let en = mic_lost(En);
        assert_eq!(
            en,
            "Your microphone disconnected. NexQ Plus reconnects it when it's back, or pick another microphone in Audio & Devices."
        );
        let zh = mic_lost(ZhCn);
        assert!(zh.contains(APP_NAME) && zh.contains("“音频与设备”") && has_cjk(&zh), "{zh}");
        assert!(privacy_blocks_output(ZhCn, "macOS").contains("macOS 的隐私设置"));
        assert!(mic_fallback(ZhCn, "abc").contains("“abc”不可用"));
        assert!(mic_fallback(En, "abc").contains("so NexQ Plus is using the default microphone"));
        assert!(output_fallback(ZhCn, "x").contains(APP_NAME));
    }

    #[test]
    fn source_messages_are_translated() {
        assert!(server_not_saved(ZhCn).starts_with("NexQ Plus 还没有保存"));
        assert!(server_not_saved(En).starts_with("NexQ Plus doesn't have this server saved yet"));
        assert!(mcp_needs_sign_in(ZhCn).contains(APP_NAME));
        assert!(problem_private_files(ZhCn).contains(APP_NAME) && problem_private_files(En).contains("NexQ Plus's"));
        assert!(only_notes_open(ZhCn).contains("笔记"));
        assert_eq!(name_list(ZhCn, &["A", "B", "C"]), "A、B 和 C");
        assert_eq!(name_list(En, &["A", "B", "C"]), "A, B and C");
        assert_eq!(retry_in_minutes(ZhCn, 2), "2 分钟后重试。");
        assert!(reading_note(ZhCn, "Dana.md").contains("Dana.md") && has_cjk(&reading_note(ZhCn, "x")));
    }

    #[test]
    fn image_and_capture_messages_are_translated() {
        assert!(images_need_claude(ZhCn).contains("设置 → AI 模型"));
        assert!(images_need_claude(En).starts_with("Images work only with Claude"));
        assert_eq!(too_many_images(ZhCn, 3), "最多可以附加 3 张图片");
        assert!(capture_failed(ZhCn).contains("截取屏幕") && capture_failed(En) == "Couldn't capture the screen");
        assert!(json_invalid(ZhCn, "x").contains("有效的 JSON"));
    }
}
