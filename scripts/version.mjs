/**
 * 版本号的唯一出处。改版本只改这里，其余脚本和安装包都跟着走。
 *
 * 为什么单放一个文件：exe 的资源版本、安装包文件名、GitHub Release 的 tag
 * 三处曾经各写各的，一改就漏。安卓那边的 versionName 在 android/app/build.gradle
 * 里（跟这里不一致时 release.mjs 会警告）。
 */
export const VERSION = '1.0.2';
