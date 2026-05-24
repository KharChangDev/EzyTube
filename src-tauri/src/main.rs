// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose, Engine as _};
use reqwest::header::{CACHE_CONTROL, CONTENT_TYPE, HOST, PRAGMA, USER_AGENT};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::collections::{hash_map::DefaultHasher, HashSet};
use std::env;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use tauri::Manager;

const DEFAULT_INVIDIOUS_INSTANCE: &str = "https://invidious.tiekoetter.com";
const TRANSLATE_FLAGS: &str = "_x_tr_sl=el&_x_tr_tl=en&_x_tr_hl=en&_x_tr_pto=wapp";
const PRIMARY_FRONT_DOMAIN: &str = "mail.google.com";
const PRIMARY_FRONT_IP: &str = "216.239.38.120";
const FALLBACK_GOOGLE_FRONTS: [&str; 2] = ["www.google.com", "images.google.com"];
const MAX_FEED_BODY_BYTES: u64 = 1024 * 1024;
const MAX_IMAGE_BODY_BYTES: u64 = 3 * 1024 * 1024;
const MAX_FEED_ITEMS: usize = 60;
const MAX_SUBSCRIPTIONS_PER_FEED: usize = 20;
const MAX_FEED_PAGE: u32 = 50;
const ALLOWED_YOUTUBE_HOSTS: [&str; 5] = [
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
];
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeProxyHealth {
    ok: bool,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeSubscription {
    id: String,
    kind: String,
    label: String,
    value: String,
    channel_id: Option<String>,
    thumbnail: Option<String>,
    added_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeFeedItem {
    video_id: String,
    title: String,
    channel_title: String,
    channel_id: Option<String>,
    thumbnail_url: Option<String>,
    published_at: Option<String>,
    duration: Option<String>,
    view_count_text: Option<String>,
    source_id: Option<String>,
    url: String,
}

fn validate_allowed_host(url: &Url, allowed_hosts: &[&str]) -> Result<(), String> {
    match url.scheme() {
        "https" => {}
        _ => return Err("Only https URLs are allowed".to_string()),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs with credentials are not allowed".to_string());
    }
    if url.port().is_some() {
        return Err("Custom URL ports are not allowed".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Target URL missing host".to_string())?;
    let host_l = host.trim_matches('.').to_ascii_lowercase();
    if !allowed_hosts.iter().any(|allowed| *allowed == host_l) {
        return Err(format!("Host {} is not allowed", host_l));
    }
    Ok(())
}

fn is_private_or_reserved_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_broadcast()
                || v.is_documentation()
                || v.octets()[0] == 0
                || v.octets()[0] >= 224
                || v.octets()[0] == 169 && v.octets()[1] == 254
        }
        IpAddr::V6(v) => {
            v.is_loopback()
                || v.is_unspecified()
                || v.segments()[0] & 0xfe00 == 0xfc00
                || v.segments()[0] & 0xffc0 == 0xfe80
        }
    }
}

fn validate_public_http_url(url: &Url) -> Result<(), String> {
    match url.scheme() {
        "https" => {}
        _ => return Err("Only https targets are allowed".to_string()),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs with credentials are not allowed".to_string());
    }
    if url.port().is_some() {
        return Err("Custom URL ports are not allowed".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Target URL missing host".to_string())?;
    let host_l = host.trim_matches('.').to_ascii_lowercase();
    if host_l == "localhost"
        || host_l.ends_with(".localhost")
        || host_l.ends_with(".local")
        || host_l == "metadata.google.internal"
        || host_l == "169.254.169.254"
        || host_l == "100.100.100.200"
    {
        return Err("Local or metadata hosts are not allowed".to_string());
    }
    if let Ok(ip) = host_l.parse::<IpAddr>() {
        if is_private_or_reserved_ip(ip) {
            return Err("Private or reserved IP targets are not allowed".to_string());
        }
    }
    Ok(())
}

fn normalize_instance(instance: Option<String>) -> Result<Url, String> {
    let raw = instance
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_INVIDIOUS_INSTANCE.to_string());
    let mut url =
        Url::parse(raw.trim()).map_err(|err| format!("Feed source URL is invalid: {}", err))?;
    validate_public_http_url(&url)?;
    url.set_username("").ok();
    url.set_password(None).ok();
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn sanitize_feed_page(page: Option<u32>) -> u32 {
    page.unwrap_or(1).clamp(1, MAX_FEED_PAGE)
}

fn translated_host_for(target: &Url) -> Result<String, String> {
    let host = target
        .host_str()
        .ok_or_else(|| "Target URL missing host".to_string())?;
    Ok(format!("{}.translate.goog", host.replace('.', "-")))
}

fn translate_front_url(target: &Url, front: &str) -> Result<Url, String> {
    validate_public_http_url(target)?;
    let mut out = Url::parse(&format!("https://{}", front)).map_err(|err| err.to_string())?;
    out.set_path(target.path());
    let query = match target.query() {
        Some(q) if !q.is_empty() => format!("{}&{}", q, TRANSLATE_FLAGS),
        _ => TRANSLATE_FLAGS.to_string(),
    };
    out.set_query(Some(&query));
    Ok(out)
}

fn translate_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    let front_ip = PRIMARY_FRONT_IP
        .parse::<IpAddr>()
        .map_err(|err| format!("Feed route IP is invalid: {}", err))?;
    let front_addr = SocketAddr::new(front_ip, 443);
    reqwest::Client::builder()
        .http1_only()
        .resolve(PRIMARY_FRONT_DOMAIN, front_addr)
        .redirect(reqwest::redirect::Policy::limited(5))
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|err| format!("Feed client failed: {}", err))
}

fn translate_fronts() -> Vec<&'static str> {
    let mut fronts = Vec::with_capacity(1 + FALLBACK_GOOGLE_FRONTS.len());
    fronts.push(PRIMARY_FRONT_DOMAIN);
    fronts.extend(FALLBACK_GOOGLE_FRONTS);
    fronts
}

async fn translate_fetch_bytes(
    target: Url,
    timeout_secs: u64,
    max_bytes: u64,
) -> Result<(Vec<u8>, Option<String>), String> {
    validate_public_http_url(&target)?;
    let translated_host = translated_host_for(&target)?;
    let client = translate_client(timeout_secs)?;

    let mut last_err = String::new();
    for front in translate_fronts() {
        let url = translate_front_url(&target, front)?;
        match client
            .get(url)
            .header(HOST, translated_host.as_str())
            .header(USER_AGENT, "Mozilla/5.0 CNS")
            .header(PRAGMA, "no-cache")
            .header(CACHE_CONTROL, "no-cache")
            .send()
            .await
        {
            Ok(resp) => {
                if !resp.status().is_success() {
                    last_err = format!("HTTP {}", resp.status());
                    continue;
                }
                let content_type = resp
                    .headers()
                    .get(CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .map(|value| value.to_string());
                let body = resp
                    .bytes()
                    .await
                    .map_err(|err| format!("Feed read failed: {}", err))?;
                if body.len() as u64 > max_bytes {
                    return Err("Feed response is too large".to_string());
                }
                return Ok((body.to_vec(), content_type));
            }
            Err(err) => {
                last_err = err.to_string();
            }
        }
    }
    Err(format!("Feed request failed: {}", last_err))
}

async fn translate_fetch_text(target: Url, timeout_secs: u64) -> Result<String, String> {
    let (body, _) = translate_fetch_bytes(target, timeout_secs, MAX_FEED_BODY_BYTES).await?;
    String::from_utf8(body).map_err(|err| format!("Feed body is not UTF-8: {}", err))
}

async fn fetch_text(target: Url, timeout_secs: u64) -> Result<String, String> {
    translate_fetch_text(target, timeout_secs).await
}

fn join_instance_path(instance: &Url, path: &str) -> Result<Url, String> {
    let allowed = [
        "/api/v1/stats",
        "/search",
        "/channel/",
    ];
    if !allowed
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(prefix))
    {
        return Err("Feed path is not available".to_string());
    }
    let mut out = instance.clone();
    out.set_path(path);
    out.set_query(None);
    out.set_fragment(None);
    validate_public_http_url(&out)?;
    Ok(out)
}

fn is_valid_video_id(value: &str) -> bool {
    value.len() == 11
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn is_valid_channel_id(value: &str) -> bool {
    value.len() == 24
        && value.starts_with("UC")
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn normalize_channel_subscription(
    channel_id: &str,
    label: String,
    thumbnail: Option<String>,
) -> YoutubeSubscription {
    YoutubeSubscription {
        id: format!("channel:{}", channel_id),
        kind: "channel".to_string(),
        label,
        value: channel_id.to_string(),
        channel_id: Some(channel_id.to_string()),
        thumbnail,
        added_at: now_iso(),
    }
}

fn clean_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalized_text(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn channel_match_score(input: &str, sub: &YoutubeSubscription) -> i32 {
    let query = normalized_text(input);
    let label = normalized_text(&sub.label);
    let value = normalized_text(&sub.value);
    let channel_id = sub
        .channel_id
        .as_deref()
        .map(normalized_text)
        .unwrap_or_default();
    let handle = sub
        .label
        .split_whitespace()
        .find(|part| part.starts_with('@'))
        .map(normalized_text)
        .unwrap_or_default();

    if query.is_empty() {
        return 0;
    }
    if label == query || value == query || channel_id == query || handle == query {
        return 300;
    }
    if label.starts_with(&query) || value.starts_with(&query) || handle.starts_with(&query) {
        return 220;
    }
    if label.contains(&query)
        || value.contains(&query)
        || channel_id.contains(&query)
        || handle.contains(&query)
    {
        return 160;
    }
    if query.contains(&label) && !label.is_empty() {
        return 120;
    }
    if query.contains(&value) && !value.is_empty() {
        return 100;
    }
    0
}

fn merge_channel_label(title: String, handle: Option<String>) -> String {
    let title = title.trim();
    let handle = handle
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    match (title.is_empty(), handle) {
        (false, Some(handle)) if !title.contains(&handle) => format!("{} {}", title, handle),
        (false, _) => title.to_string(),
        (true, Some(handle)) => handle,
        (true, None) => String::new(),
    }
}

fn choose_best_channel_subscription(
    input: &str,
    channels: Vec<YoutubeSubscription>,
) -> Option<YoutubeSubscription> {
    best_subscription_match(input, channels)
}

fn best_subscription_match(
    input: &str,
    items: impl IntoIterator<Item = YoutubeSubscription>,
) -> Option<YoutubeSubscription> {
    items
        .into_iter()
        .filter_map(|sub| {
            let score = channel_match_score(input, &sub);
            if score > 0 {
                Some((score, sub))
            } else {
                None
            }
        })
        .max_by_key(|(score, _)| *score)
        .map(|(_, sub)| sub)
}

fn decode_html_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
}

fn strip_tags(value: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    clean_text(&decode_html_entities(&out))
}

fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let needle = format!("{}=", attr);
    let start = tag.find(&needle)? + needle.len();
    let rest = &tag[start..];
    let quote = rest.chars().next()?;
    if quote == '"' || quote == '\'' {
        let value_start = quote.len_utf8();
        let value_end = rest[value_start..].find(quote)? + value_start;
        return Some(decode_html_entities(&rest[value_start..value_end]));
    }
    let value_end = rest
        .find(|ch: char| ch.is_ascii_whitespace() || ch == '>')
        .unwrap_or(rest.len());
    Some(decode_html_entities(&rest[..value_end]))
}

fn floor_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while index > 0 && !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while index < value.len() && !value.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn find_before_index(
    haystack: &str,
    end: usize,
    needle: &str,
    max_distance: usize,
) -> Option<usize> {
    let end = floor_char_boundary(haystack, end);
    let start = floor_char_boundary(haystack, end.saturating_sub(max_distance));
    let window = &haystack[start..end];
    window.rfind(needle).map(|rel| start + rel)
}

fn find_after_index(
    haystack: &str,
    start: usize,
    needle: &str,
    max_distance: usize,
) -> Option<usize> {
    let start = floor_char_boundary(haystack, start);
    let end = ceil_char_boundary(haystack, start.saturating_add(max_distance));
    let window = &haystack[start..end];
    window.find(needle).map(|rel| start + rel)
}

fn find_after<'a>(
    haystack: &'a str,
    start: usize,
    needle: &str,
    max_distance: usize,
) -> Option<&'a str> {
    let start = floor_char_boundary(haystack, start);
    let end = ceil_char_boundary(haystack, start.saturating_add(max_distance));
    let window = &haystack[start..end];
    let rel = window.find(needle)?;
    Some(&haystack[start + rel..end])
}

fn first_p_text_after_marker(fragment: &str, marker: &str) -> Option<String> {
    let marker_start = fragment.find(marker)?;
    let p_start = fragment[marker_start..].find("<p")? + marker_start;
    let tag_end = fragment[p_start..].find('>')? + p_start + 1;
    let close = fragment[tag_end..].find("</p>")? + tag_end;
    let text = strip_tags(&fragment[tag_end..close]);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn p_texts_after_marker(fragment: &str, marker: &str, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut cursor = 0;
    while let Some(rel) = fragment[cursor..].find(marker) {
        let p_start = cursor + rel;
        let Some(tag_end_rel) = fragment[p_start..].find('>') else {
            break;
        };
        let tag_end = p_start + tag_end_rel + 1;
        let Some(close_rel) = fragment[tag_end..].find("</p>") else {
            break;
        };
        let close = tag_end + close_rel;
        let text = strip_tags(&fragment[tag_end..close]);
        if !text.is_empty() {
            out.push(text);
            if out.len() >= limit {
                break;
            }
        }
        cursor = close + "</p>".len();
    }
    out
}

fn first_img_src(fragment: &str) -> Option<String> {
    let img_start = fragment.find("<img")?;
    let img_end = fragment[img_start..].find('>')? + img_start + 1;
    let tag = &fragment[img_start..img_end];
    attr_value(tag, "data-src").or_else(|| attr_value(tag, "src"))
}

fn tag_attr_at(fragment: &str, tag_start: usize, attr: &str) -> Option<String> {
    let tag_end = fragment[tag_start..].find('>')? + tag_start + 1;
    attr_value(&fragment[tag_start..tag_end], attr)
}

fn channel_id_from_href(href: &str) -> Option<String> {
    let decoded = decode_html_entities(href);
    if decoded.starts_with("/channel/") {
        return decoded
            .trim_start_matches("/channel/")
            .split(|ch| ch == '/' || ch == '?' || ch == '#')
            .next()
            .filter(|value| is_valid_channel_id(value))
            .map(str::to_string);
    }
    if decoded.starts_with("https://") {
        let parsed = Url::parse(&decoded).ok()?;
        let segments: Vec<_> = parsed
            .path_segments()
            .map(|s| s.collect())
            .unwrap_or_default();
        if let Some(pos) = segments.iter().position(|s| *s == "channel") {
            return segments
                .get(pos + 1)
                .filter(|value| is_valid_channel_id(value))
                .map(|value| (*value).to_string());
        }
    }
    None
}

fn normalize_published_text(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed
        .get(..7)
        .map(|prefix| prefix.eq_ignore_ascii_case("shared "))
        .unwrap_or(false)
    {
        trimmed[7..].trim().to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_duration_text(value: &str) -> Option<String> {
    let text = clean_text(value);
    if text.is_empty() {
        return None;
    }
    let normalized = text.to_ascii_lowercase();
    if normalized.contains("video") || normalized.contains("views") || normalized.contains("watching") {
        return None;
    }
    let mut parts = text.split(':');
    let count = parts.by_ref().take(4).count();
    if (2..=3).contains(&count)
        && text
            .chars()
            .all(|ch| ch.is_ascii_digit() || ch == ':' || ch.is_ascii_whitespace())
    {
        Some(text)
    } else {
        None
    }
}

fn image_cache_key(url: &Url) -> String {
    let mut hasher = DefaultHasher::new();
    url.as_str().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

fn mime_from_response(content_type: Option<&str>, bytes: &[u8]) -> Result<&'static str, String> {
    if let Some(value) = content_type {
        let mime = value.split(';').next().unwrap_or("").trim();
        if mime.starts_with("image/") {
            return Ok(match mime {
                "image/jpeg" | "image/jpg" => "image/jpeg",
                "image/png" => "image/png",
                "image/gif" => "image/gif",
                "image/webp" => "image/webp",
                "image/bmp" => "image/bmp",
                "image/svg+xml" => "image/svg+xml",
                _ => "image/jpeg",
            });
        }
    }
    sniff_image_mime(bytes).ok_or_else(|| "Feed image is unavailable".to_string())
}

fn cached_image_path(window: &tauri::Window, url: &Url) -> Result<PathBuf, String> {
    let app = window.app_handle();
    let root = app
        .path()
        .app_cache_dir()
        .or_else(|_| app.path().app_data_dir())
        .or_else(|_| app.path().app_config_dir())
        .map_err(|err| format!("Feed cache directory is unavailable: {}", err))?;
    let dir = root.join("youtube-feed-images");
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Feed cache directory could not be created: {}", err))?;
    Ok(dir.join(format!("{}.img", image_cache_key(url))))
}

fn image_data_url(bytes: &[u8], content_type: Option<&str>) -> Result<String, String> {
    let mime = mime_from_response(content_type, bytes)?;
    Ok(format!(
        "data:{};base64,{}",
        mime,
        general_purpose::STANDARD.encode(bytes)
    ))
}

fn normalize_image_target(raw: &str, instance: Option<String>) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Image URL is empty".to_string());
    }
    let url = if trimmed.starts_with("//") {
        Url::parse(&format!("https:{}", trimmed)).map_err(|err| err.to_string())?
    } else if trimmed.starts_with('/') {
        normalize_instance(instance)?
            .join(trimmed)
            .map_err(|err| err.to_string())?
    } else {
        Url::parse(trimmed).map_err(|err| err.to_string())?
    };
    validate_public_http_url(&url)?;
    Ok(url)
}

fn normalize_thumbnail_url(raw: &str, instance: &Url) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    if value.starts_with("//") {
        return Some(format!("https:{}", value));
    }
    if value.starts_with('/') {
        return instance.join(value).ok().map(|url| url.to_string());
    }
    Url::parse(value)
        .ok()
        .filter(|url| url.scheme() == "https")
        .map(|url| url.to_string())
}

fn video_id_from_href(href: &str) -> Option<String> {
    let decoded = decode_html_entities(href);
    let url = if decoded.starts_with("/watch") || decoded.starts_with("/playlist") {
        Url::parse(&format!("https://www.youtube.com{}", decoded)).ok()?
    } else if decoded.starts_with("https://") {
        Url::parse(&decoded).ok()?
    } else {
        return None;
    };
    let id = if url.path().starts_with("/watch") {
        url.query_pairs()
            .find(|(name, _)| name == "v")
            .map(|(_, value)| value.to_string())?
    } else if url.path().starts_with("/playlist") {
        url.query_pairs()
            .find(|(name, _)| name == "list")
            .map(|(_, value)| value.to_string())?
    } else {
        return None;
    };
    if is_valid_video_id(&id) {
        Some(id)
    } else {
        None
    }
}

fn channel_id_from_fragment(fragment: &str) -> Option<String> {
    let mut cursor = 0;
    while let Some(rel) = fragment[cursor..].find("/channel/UC") {
        let start = cursor + rel + "/channel/".len();
        let end = (start + 24).min(fragment.len());
        let channel_id = &fragment[start..end];
        if is_valid_channel_id(channel_id) {
            return Some(channel_id.to_string());
        }
        cursor = end;
    }
    None
}

fn html_title_text(html: &str) -> Option<String> {
    let start = html.find("<title>")? + "<title>".len();
    let end = html[start..].find("</title>")? + start;
    let title = strip_tags(&html[start..end])
        .trim_end_matches(" - Invidious")
        .trim_end_matches(" - YouTube")
        .trim()
        .to_string();
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

fn parse_invidious_html_feed(html: &str, instance: &Url, limit: usize) -> Vec<YoutubeFeedItem> {
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = 0;

    while let Some(href_rel) = html[cursor..].find("href=\"") {
        let href_start = cursor + href_rel + "href=\"".len();
        let Some(href_end_rel) = html[href_start..].find('"') else {
            break;
        };
        let href_end = href_start + href_end_rel;
        let href = &html[href_start..href_end];
        cursor = href_end + 1;

        let Some(video_id) = video_id_from_href(href) else {
            continue;
        };
        if !seen.insert(video_id.clone()) {
            continue;
        }

        let card_start = find_before_index(html, href_start, "<div class=\"h-box\"", 1800)
            .or_else(|| find_before_index(html, href_start, "<div class=\"pure-u", 1800))
            .unwrap_or(href_start.saturating_sub(1200));
        let next_card = find_after_index(html, href_end, "<div class=\"h-box\"", 4500)
            .or_else(|| find_after_index(html, href_end, "<div class=\"pure-u", 4500))
            .unwrap_or((card_start + 4500).min(html.len()));
        let card = &html[card_start..next_card.min(html.len())];

        let title = first_p_text_after_marker(card, "video-card-row")
            .or_else(|| {
                find_after(html, href_end, "<p", 500).and_then(|fragment| {
                    let p_start = fragment.find('>')? + 1;
                    let p_end = fragment[p_start..].find("</p>")? + p_start;
                    Some(strip_tags(&fragment[p_start..p_end]))
                })
            })
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| video_id.clone());

        let channel_title = first_p_text_after_marker(card, "<p class=\"channel-name\"")
            .or_else(|| {
                let after = find_after(html, href_end, "<p class=\"channel-name\"", 1600)?;
                let start = after.find('>')?;
                let end = after[start + 1..].find("</p>")?;
                Some(strip_tags(&after[start + 1..start + 1 + end]))
            })
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "YouTube".to_string());
        let channel_id = channel_id_from_fragment(card).or_else(|| {
            let after = find_after(html, href_end, "/channel/UC", 1800)?;
            channel_id_from_fragment(after)
        });
        let thumbnail_url =
            first_img_src(card).and_then(|src| normalize_thumbnail_url(&src, instance));
        let duration = first_p_text_after_marker(card, "<p class=\"length\"")
            .and_then(|text| normalize_duration_text(&text));
        let metadata = p_texts_after_marker(card, "class=\"video-data\"", 4);
        let view_count_text = metadata
            .iter()
            .find(|text| text.to_ascii_lowercase().contains("view"))
            .cloned();
        let published_at = metadata
            .iter()
            .find(|text| !text.to_ascii_lowercase().contains("view"))
            .map(|text| normalize_published_text(text));

        items.push(YoutubeFeedItem {
            video_id: video_id.clone(),
            title,
            channel_title,
            channel_id,
            thumbnail_url,
            published_at,
            duration,
            view_count_text,
            source_id: None,
            url: format!("https://www.youtube.com/watch?v={}", video_id),
        });

        if items.len() >= limit {
            break;
        }
    }

    items
}

fn parse_invidious_html_channels(
    html: &str,
    input: &str,
    limit: usize,
) -> Vec<YoutubeSubscription> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = 0;

    while let Some(channel_rel) = html[cursor..].find("/channel/UC") {
        let href_marker = cursor + channel_rel;
        let Some(anchor_start) = find_before_index(html, href_marker, "<a", 320) else {
            cursor = href_marker + "/channel/".len();
            continue;
        };
        let href = tag_attr_at(html, anchor_start, "href").unwrap_or_default();
        let Some(channel_id) =
            channel_id_from_href(&href).or_else(|| channel_id_from_fragment(&html[href_marker..]))
        else {
            cursor = href_marker + "/channel/".len();
            continue;
        };
        cursor = href_marker + "/channel/".len();
        let card_start = find_before_index(html, anchor_start, "<div class=\"h-box\"", 2400)
            .or_else(|| find_before_index(html, anchor_start, "<div class=\"pure-u", 2400))
            .unwrap_or(anchor_start.saturating_sub(1600));
        let card_end = find_after_index(html, anchor_start, "<div class=\"pure-u", 4200)
            .or_else(|| find_after_index(html, anchor_start, "<div class=\"h-box\"", 4200))
            .unwrap_or((anchor_start + 4200).min(html.len()));
        let card = &html[card_start..card_end.min(html.len())];
        if video_id_from_href(&href).is_some() || card.contains("href=\"/watch") {
            continue;
        }
        if !seen.insert(channel_id.clone()) {
            continue;
        }

        let title = first_p_text_after_marker(card, "video-card-row")
            .or_else(|| first_p_text_after_marker(card, "<p class=\"channel-name\""))
            .unwrap_or_else(|| input.to_string());
        let handle = p_texts_after_marker(card, "class=\"channel-name\"", 3)
            .into_iter()
            .find(|text| text.trim_start().starts_with('@'));
        let label = merge_channel_label(title, handle);

        let label = if label.is_empty() {
            input.to_string()
        } else {
            label
        };

        out.push(normalize_channel_subscription(&channel_id, label, None));

        if out.len() >= limit {
            break;
        }
    }

    out
}

fn now_iso() -> String {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => format!("{}", d.as_secs()),
        Err(_) => "0".to_string(),
    }
}

async fn invidious_search_html(
    instance: &Url,
    query: &str,
    search_type: &str,
    limit: usize,
    page: u32,
) -> Result<Vec<YoutubeFeedItem>, String> {
    let mut url = join_instance_path(instance, "/search")?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("type", search_type)
        .append_pair("page", &page.to_string());
    let html = fetch_text(url, 14).await?;
    Ok(parse_invidious_html_feed(&html, instance, limit))
}

async fn invidious_channel_search_html(
    instance: &Url,
    query: &str,
    limit: usize,
    page: u32,
) -> Result<Vec<YoutubeSubscription>, String> {
    let mut url = join_instance_path(instance, "/search")?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("type", "channel")
        .append_pair("page", &page.to_string());
    let html = fetch_text(url, 14).await?;
    let channels = parse_invidious_html_channels(&html, query, limit.saturating_mul(4));
    Ok(match choose_best_channel_subscription(query, channels) {
        Some(best) => vec![best],
        None => Vec::new(),
    })
}

async fn invidious_channel_videos_html(
    instance: &Url,
    channel_id: &str,
    page: u32,
) -> Result<Vec<YoutubeFeedItem>, String> {
    let path = format!("/channel/{}/videos", channel_id);
    let mut url = join_instance_path(instance, &path)?;
    url.query_pairs_mut().append_pair("page", &page.to_string());
    let html = fetch_text(url, 14).await?;
    Ok(parse_invidious_html_feed(&html, instance, 18))
}

async fn invidious_channel_subscription_html(
    instance: &Url,
    channel_id: &str,
) -> Result<YoutubeSubscription, String> {
    if !is_valid_channel_id(channel_id) {
        return Err("Invalid channel id".to_string());
    }
    let path = format!("/channel/{}", channel_id);
    let url = join_instance_path(instance, &path)?;
    let html = fetch_text(url, 14).await?;
    let label = html_title_text(&html).unwrap_or_else(|| channel_id.to_string());
    Ok(normalize_channel_subscription(channel_id, label, None))
}

async fn resolve_channel_id_subscription(
    instance: &Url,
    channel_id: &str,
) -> Result<YoutubeSubscription, String> {
    invidious_channel_subscription_html(instance, channel_id).await
}

async fn resolve_channel_search(
    instance: &Url,
    _match_input: &str,
    query: &str,
) -> Option<YoutubeSubscription> {
    if let Ok(channels) = invidious_channel_search_html(instance, query, 1, 1).await {
        if let Some(sub) = channels.into_iter().next() {
            return Some(sub);
        }
    }

    None
}

fn scoped_channel_items(channel_id: &str, mut items: Vec<YoutubeFeedItem>) -> Vec<YoutubeFeedItem> {
    items.retain(|item| {
        item.channel_id
            .as_deref()
            .map(|item_channel_id| item_channel_id == channel_id)
            .unwrap_or(true)
    });
    for item in &mut items {
        if item.channel_id.is_none() {
            item.channel_id = Some(channel_id.to_string());
        }
    }
    items
}

fn subscription_channel_id(sub: &YoutubeSubscription) -> Option<&str> {
    sub.channel_id
        .as_deref()
        .filter(|value| is_valid_channel_id(value))
        .or_else(|| {
            let value = sub.value.as_str();
            if is_valid_channel_id(value) {
                Some(value)
            } else {
                None
            }
        })
}

#[tauri::command]
fn export_logs_to_file(window: tauri::Window, content: String) -> Result<String, String> {
    fn unique_file_path(base: PathBuf) -> PathBuf {
        if !base.exists() {
            return base;
        }

        let mut index = 1;
        loop {
            let candidate = base.with_file_name(format!("cns-startup-log-{}.json", index));
            if !candidate.exists() {
                return candidate;
            }
            index += 1;
        }
    }

    fn ensure_dir(path: &PathBuf) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)
                .map_err(|err| format!("Failed to create directory {}: {}", dir.display(), err))
        } else {
            Err("Failed to determine parent directory".to_string())
        }
    }

    fn write_file(path: PathBuf, content: &str) -> Result<PathBuf, String> {
        ensure_dir(&path)?;
        let mut file = fs::File::create(&path)
            .map_err(|err| format!("Failed to create {}: {}", path.display(), err))?;
        file.write_all(content.as_bytes())
            .map_err(|err| format!("Failed to write {}: {}", path.display(), err))?;
        Ok(path)
    }

    let app = window.app_handle();
    let install_dir = env::current_exe()
        .map_err(|err| format!("Failed to locate executable path: {}", err))?
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "Failed to determine install directory".to_string())?;

    let install_file = unique_file_path(install_dir.join("cns-startup-log.json"));
    match write_file(install_file.clone(), &content) {
        Ok(path) => return Ok(path.to_string_lossy().to_string()),
        Err(install_err) => {
            let app_dir = app
                .path()
                .app_data_dir()
                .or_else(|_| app.path().app_config_dir())
                .map_err(|_| {
                    format!(
                        "Install write failed: {}; app data dir unavailable",
                        install_err
                    )
                })?;
            let fallback_file = unique_file_path(app_dir.join("cns-startup-log.json"));
            let path = write_file(fallback_file.clone(), &content).map_err(|fallback_err| {
                format!(
                    "Install write failed: {}; fallback write failed: {}",
                    install_err, fallback_err
                )
            })?;
            return Ok(path.to_string_lossy().to_string());
        }
    }
}

#[tauri::command]
fn set_secure_github_token(token: String) -> Result<(), String> {
    let entry = keyring::Entry::new("cns", "github_token")
        .map_err(|err| format!("Failed to create keyring entry: {}", err))?;
    entry
        .set_password(&token)
        .map_err(|err| format!("Failed to store token in keyring: {}", err))?;
    Ok(())
}

#[tauri::command]
fn get_secure_github_token() -> Result<String, String> {
    let entry = keyring::Entry::new("cns", "github_token")
        .map_err(|err| format!("Failed to create keyring entry: {}", err))?;
    entry
        .get_password()
        .map_err(|err| format!("Failed to read token from keyring: {}", err))
}

#[tauri::command]
fn clear_secure_github_token() -> Result<(), String> {
    let entry = keyring::Entry::new("cns", "github_token")
        .map_err(|err| format!("Failed to create keyring entry: {}", err))?;
    match entry.delete_password() {
        Ok(_) => Ok(()),
        Err(_) => Ok(()),
    }
}

#[tauri::command]
async fn download_github_file(
    window: tauri::Window,
    owner: String,
    repo: String,
    token: String,
    path: String,
    file_name: String,
) -> Result<String, String> {
    let encoded_path = path
        .split('/')
        .map(|segment| urlencoding::encode(segment).to_string())
        .collect::<Vec<String>>()
        .join("/");
    let url = format!(
        "https://api.github.com/repos/{}/{}/contents/{}",
        owner, repo, encoded_path
    );
    let client = reqwest::Client::new();
    let mut response = client
        .get(url)
        .header("Accept", "application/vnd.github.raw")
        .header("Authorization", format!("token {}", token))
        .header("User-Agent", "CNS-YouTube-Downloader")
        .send()
        .await
        .map_err(|err| format!("E_NET_REQ: {}", err))?;
    if !response.status().is_success() {
        return Err(format!("E_HTTP_{}: download failed", response.status()));
    }
    let resolver = window.app_handle().path();
    let mut target = resolver
        .download_dir()
        .or_else(|_| resolver.app_data_dir())
        .or_else(|_| resolver.app_config_dir())
        .map_err(|_| "E_DIR_RESOLVE: cannot resolve writable directory".to_string())?;
    if let Err(err) = fs::create_dir_all(&target) {
        return Err(format!("E_DIR_CREATE: {}: {}", target.display(), err));
    }
    target.push(file_name);
    let mut tmp_path = target.clone();
    let file_name_tmp = match tmp_path.file_name().and_then(|s| s.to_str()) {
        Some(name) => format!("{}.part", name),
        None => "download.part".to_string(),
    };
    tmp_path.set_file_name(file_name_tmp);
    let mut output = fs::File::create(&tmp_path)
        .map_err(|err| format!("E_FILE_CREATE: {}: {}", tmp_path.display(), err))?;
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|err| format!("E_STREAM_READ: {}", err))?;
        match chunk {
            Some(bytes) => output
                .write_all(&bytes)
                .map_err(|err| format!("E_FILE_WRITE: {}: {}", tmp_path.display(), err))?,
            None => break,
        }
    }
    output
        .flush()
        .map_err(|err| format!("E_FILE_FLUSH: {}: {}", tmp_path.display(), err))?;
    fs::rename(&tmp_path, &target).map_err(|err| {
        format!(
            "E_FILE_RENAME: {} -> {}: {}",
            tmp_path.display(),
            target.display(),
            err
        )
    })?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
async fn yt_proxy_health(instance: Option<String>) -> Result<YoutubeProxyHealth, String> {
    let instance = normalize_instance(instance)?;
    let mut url = join_instance_path(&instance, "/api/v1/stats")?;
    url.set_query(None);
    match translate_fetch_text(url, 10).await {
        Ok(_) => Ok(YoutubeProxyHealth {
            ok: true,
            message: None,
        }),
        Err(err) => Ok(YoutubeProxyHealth {
            ok: false,
            message: Some(err),
        }),
    }
}

#[tauri::command]
async fn yt_proxy_search(
    query: String,
    instance: Option<String>,
    page: Option<u32>,
) -> Result<Vec<YoutubeFeedItem>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let instance = normalize_instance(instance)?;
    let page = sanitize_feed_page(page);
    invidious_search_html(&instance, q, "video", 36, page).await
}

#[tauri::command]
async fn yt_proxy_resolve_subscription(
    input: String,
    instance: Option<String>,
) -> Result<YoutubeSubscription, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("Subscription input is empty".to_string());
    }
    let instance = normalize_instance(instance)?;
    let instance_host = instance.host_str().unwrap_or_default().to_ascii_lowercase();

    if raw.starts_with("UC") && raw.len() >= 20 {
        if !is_valid_channel_id(raw) {
            return Err("Invalid channel id".to_string());
        }
        return resolve_channel_id_subscription(&instance, raw)
            .await
            .or_else(|_| Ok(normalize_channel_subscription(raw, raw.to_string(), None)));
    }

    if let Ok(parsed) = Url::parse(raw) {
        validate_public_http_url(&parsed)?;
        let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
        if !(ALLOWED_YOUTUBE_HOSTS.iter().any(|allowed| *allowed == host) || host == instance_host)
        {
            return Err(format!("Host {} is not allowed", host));
        }
        if host != instance_host {
            validate_allowed_host(&parsed, &ALLOWED_YOUTUBE_HOSTS)?;
        }
        {
            let segments: Vec<_> = parsed
                .path_segments()
                .map(|s| s.collect())
                .unwrap_or_default();
            if let Some(pos) = segments.iter().position(|s| *s == "channel") {
                if let Some(channel_id) = segments.get(pos + 1) {
                    if is_valid_channel_id(channel_id) {
                        return resolve_channel_id_subscription(&instance, channel_id)
                            .await
                            .or_else(|_| {
                                Ok(normalize_channel_subscription(
                                    channel_id,
                                    (*channel_id).to_string(),
                                    None,
                                ))
                            });
                    }
                    return Err("Invalid channel id".to_string());
                }
            }
            if let Some(first) = segments.first() {
                if first.starts_with('@') {
                    let handle = first.trim_start_matches('@');
                    let match_input = first.trim_start_matches('@');
                    if let Some(sub) = resolve_channel_search(&instance, match_input, handle).await
                    {
                        return Ok(sub);
                    }
                    return Err("YouTube channel could not be resolved".to_string());
                }
            }
        }
        return Err("Expected a YouTube channel URL, handle, or channel id".to_string());
    }

    let search_query = raw.trim_start_matches('@');
    if let Some(sub) = resolve_channel_search(&instance, search_query, search_query).await {
        return Ok(sub);
    }

    Err("YouTube channel could not be resolved".to_string())
}

#[tauri::command]
async fn yt_proxy_subscription_feed(
    subscriptions: Vec<YoutubeSubscription>,
    instance: Option<String>,
    page: Option<u32>,
) -> Result<Vec<YoutubeFeedItem>, String> {
    let instance = normalize_instance(instance)?;
    let page = sanitize_feed_page(page);
    let mut groups: Vec<Vec<YoutubeFeedItem>> = Vec::new();
    for sub in subscriptions.iter().take(MAX_SUBSCRIPTIONS_PER_FEED) {
        let mut items = if sub.kind == "channel" {
            match subscription_channel_id(sub) {
                Some(channel_id) => {
                    let items = invidious_channel_videos_html(&instance, channel_id, page)
                        .await
                        .unwrap_or_default();
                    scoped_channel_items(channel_id, items)
                }
                _ => Vec::new(),
            }
        } else {
            invidious_search_html(&instance, &sub.value, "video", 12, page)
                .await
                .unwrap_or_default()
        };
        for item in &mut items {
            item.source_id = Some(sub.id.clone());
        }
        if !items.is_empty() {
            groups.push(items);
        }
    }

    let mut out: Vec<YoutubeFeedItem> = Vec::new();
    let mut index = 0;
    loop {
        let mut pushed = false;
        for group in &groups {
            if let Some(item) = group.get(index) {
                out.push(item.clone());
                pushed = true;
                if out.len() >= MAX_FEED_ITEMS * 2 {
                    break;
                }
            }
        }
        if !pushed || out.len() >= MAX_FEED_ITEMS * 2 {
            break;
        }
        index += 1;
    }

    let mut seen = HashSet::new();
    out.retain(|item| seen.insert(item.video_id.clone()));
    out.truncate(MAX_FEED_ITEMS);
    Ok(out)
}

#[tauri::command]
async fn yt_proxy_image(
    window: tauri::Window,
    url: String,
    instance: Option<String>,
) -> Result<String, String> {
    let target = normalize_image_target(&url, instance)?;
    let path = cached_image_path(&window, &target)?;
    if let Ok(bytes) = fs::read(&path) {
        if !bytes.is_empty() {
            return image_data_url(&bytes, None);
        }
    }

    let (bytes, content_type) = translate_fetch_bytes(target, 12, MAX_IMAGE_BODY_BYTES).await?;
    let data_url = image_data_url(&bytes, content_type.as_deref())?;
    let tmp_path = path.with_extension("part");
    fs::write(&tmp_path, &bytes)
        .map_err(|err| format!("Feed image cache write failed: {}", err))?;
    fs::rename(&tmp_path, &path)
        .or_else(|_| {
            fs::write(&path, &bytes)?;
            let _ = fs::remove_file(&tmp_path);
            Ok::<(), std::io::Error>(())
        })
        .map_err(|err| format!("Feed image cache update failed: {}", err))?;
    Ok(data_url)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            export_logs_to_file,
            set_secure_github_token,
            get_secure_github_token,
            clear_secure_github_token,
            download_github_file,
            yt_proxy_health,
            yt_proxy_search,
            yt_proxy_resolve_subscription,
            yt_proxy_subscription_feed,
            yt_proxy_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
