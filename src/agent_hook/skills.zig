//! Installs the "mosttly-tabs" agent skill that teaches Claude Code and
//! Codex how to open new tabs in the running app via
//! `ghostty-agent-hook new-tab`.
//!
//! Claude Code discovers personal skills in `~/.claude/skills` (or
//! `$CLAUDE_CONFIG_DIR/skills`). Codex discovers user skills in
//! `~/.agents/skills`, the cross-agent standard location.

const std = @import("std");

const Allocator = std.mem.Allocator;

pub const skill_dir_name = "mosttly-tabs";
pub const skill_content = @embedFile("skill/SKILL.md");

/// Marker that identifies skill files we own. Uninstall refuses to delete
/// files without it so we never destroy a user's hand-written skill.
const ownership_marker = "managed by ghostty-agent-hook";

pub fn installClaude(alloc: Allocator) !void {
    const root = try claudeSkillsRoot(alloc);
    defer alloc.free(root);
    const path = try writeSkill(alloc, root);
    defer alloc.free(path);
    try printStatus("Claude Code skill installed at ", path);
}

pub fn uninstallClaude(alloc: Allocator) !void {
    const root = try claudeSkillsRoot(alloc);
    defer alloc.free(root);
    const path = try removeSkill(alloc, root);
    defer alloc.free(path);
    try printStatus("Claude Code skill removed from ", path);
}

pub fn installCodex(alloc: Allocator) !void {
    const root = try agentsSkillsRoot(alloc);
    defer alloc.free(root);
    const path = try writeSkill(alloc, root);
    defer alloc.free(path);
    try printStatus("Codex skill installed at ", path);
}

pub fn uninstallCodex(alloc: Allocator) !void {
    const root = try agentsSkillsRoot(alloc);
    defer alloc.free(root);
    const path = try removeSkill(alloc, root);
    defer alloc.free(path);
    try printStatus("Codex skill removed from ", path);
}

/// `$CLAUDE_CONFIG_DIR/skills`, else `~/.claude/skills`.
fn claudeSkillsRoot(alloc: Allocator) ![]const u8 {
    if (try envOwned(alloc, "CLAUDE_CONFIG_DIR")) |config_dir| {
        defer alloc.free(config_dir);
        return try std.fs.path.join(alloc, &.{ config_dir, "skills" });
    }
    const home = try envOwned(alloc, "HOME") orelse return error.HomeNotSet;
    defer alloc.free(home);
    return try std.fs.path.join(alloc, &.{ home, ".claude", "skills" });
}

/// `~/.agents/skills`: the cross-agent user skills location Codex reads.
fn agentsSkillsRoot(alloc: Allocator) ![]const u8 {
    const home = try envOwned(alloc, "HOME") orelse return error.HomeNotSet;
    defer alloc.free(home);
    return try std.fs.path.join(alloc, &.{ home, ".agents", "skills" });
}

/// Writes the skill under `skills_root` and returns the SKILL.md path.
/// Refuses to overwrite a same-named skill we don't own.
pub fn writeSkill(alloc: Allocator, skills_root: []const u8) ![]const u8 {
    const dir_path = try std.fs.path.join(alloc, &.{ skills_root, skill_dir_name });
    defer alloc.free(dir_path);
    const file_path = try std.fs.path.join(alloc, &.{ dir_path, "SKILL.md" });
    errdefer alloc.free(file_path);

    if (readFileAllocIfExists(alloc, file_path)) |existing| {
        defer alloc.free(existing);
        if (existing.len > 0 and std.mem.indexOf(u8, existing, ownership_marker) == null) {
            return error.ForeignSkillExists;
        }
    } else |err| return err;

    try std.fs.cwd().makePath(dir_path);
    const file = try std.fs.createFileAbsolute(file_path, .{});
    defer file.close();
    try file.writeAll(skill_content);

    return file_path;
}

/// Removes the skill under `skills_root` if we own it and returns the
/// SKILL.md path. Removing an absent skill succeeds.
pub fn removeSkill(alloc: Allocator, skills_root: []const u8) ![]const u8 {
    const dir_path = try std.fs.path.join(alloc, &.{ skills_root, skill_dir_name });
    defer alloc.free(dir_path);
    const file_path = try std.fs.path.join(alloc, &.{ dir_path, "SKILL.md" });
    errdefer alloc.free(file_path);

    const existing = try readFileAllocIfExists(alloc, file_path);
    defer alloc.free(existing);
    if (existing.len == 0) return file_path;
    if (std.mem.indexOf(u8, existing, ownership_marker) == null) {
        return error.ForeignSkillExists;
    }

    try std.fs.deleteFileAbsolute(file_path);
    std.fs.deleteDirAbsolute(dir_path) catch {};

    return file_path;
}

fn readFileAllocIfExists(alloc: Allocator, path: []const u8) ![]const u8 {
    const file = std.fs.openFileAbsolute(path, .{}) catch |err| switch (err) {
        error.FileNotFound => return try alloc.dupe(u8, ""),
        else => return err,
    };
    defer file.close();
    return try file.readToEndAlloc(alloc, 1024 * 1024);
}

fn printStatus(prefix: []const u8, path: []const u8) !void {
    var buffer: [1024]u8 = undefined;
    var stdout = std.fs.File.stdout().writer(&buffer);
    try stdout.interface.writeAll(prefix);
    try stdout.interface.writeAll(path);
    try stdout.interface.writeByte('\n');
    try stdout.interface.flush();
}

fn envOwned(alloc: Allocator, key: []const u8) !?[]const u8 {
    return std.process.getEnvVarOwned(alloc, key) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => null,
        else => return err,
    };
}

test "skill content has required frontmatter and ownership marker" {
    const testing = std.testing;
    try testing.expect(std.mem.startsWith(u8, skill_content, "---\n"));
    try testing.expect(std.mem.indexOf(u8, skill_content, "name: mosttly-tabs") != null);
    try testing.expect(std.mem.indexOf(u8, skill_content, "description: ") != null);
    try testing.expect(std.mem.indexOf(u8, skill_content, ownership_marker) != null);
    try testing.expect(std.mem.indexOf(u8, skill_content, "ghostty-agent-hook new-tab") != null);
}

test "write and remove skill round trip" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const root = try tmp.dir.realpathAlloc(alloc, ".");
    defer alloc.free(root);

    const written = try writeSkill(alloc, root);
    defer alloc.free(written);

    const contents = try readFileAllocIfExists(alloc, written);
    defer alloc.free(contents);
    try testing.expectEqualStrings(skill_content, contents);

    // Reinstall over our own file succeeds.
    const rewritten = try writeSkill(alloc, root);
    defer alloc.free(rewritten);

    const removed = try removeSkill(alloc, root);
    defer alloc.free(removed);
    const after = try readFileAllocIfExists(alloc, removed);
    defer alloc.free(after);
    try testing.expectEqual(@as(usize, 0), after.len);

    // Removing an absent skill succeeds.
    const removed_again = try removeSkill(alloc, root);
    defer alloc.free(removed_again);
}

test "write and remove refuse foreign skill files" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.makePath(skill_dir_name);
    const foreign = "---\nname: mosttly-tabs\n---\nuser-authored skill\n";
    try tmp.dir.writeFile(.{
        .sub_path = skill_dir_name ++ "/SKILL.md",
        .data = foreign,
    });

    const root = try tmp.dir.realpathAlloc(alloc, ".");
    defer alloc.free(root);

    try testing.expectError(error.ForeignSkillExists, writeSkill(alloc, root));
    try testing.expectError(error.ForeignSkillExists, removeSkill(alloc, root));

    const skill_path = try std.fs.path.join(alloc, &.{ root, skill_dir_name, "SKILL.md" });
    defer alloc.free(skill_path);
    const contents = try readFileAllocIfExists(alloc, skill_path);
    defer alloc.free(contents);
    try testing.expectEqualStrings(foreign, contents);
}
