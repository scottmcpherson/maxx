//! Installs the Maxx agent skills that teach Claude Code and Codex how to
//! drive the running app:
//!
//!   * `maxx-tabs` — open and manage visible tabs via `maxx-agent-hook`.
//!   * `maxx-supervisor-workflows` — coordinate child tabs from a parent
//!     session via the `maxx +control` API (spawn/declare/watch/intervene/
//!     summarize/delegate).
//!
//! Claude Code discovers personal skills in `~/.claude/skills` (or
//! `$CLAUDE_CONFIG_DIR/skills`). Codex discovers user skills in
//! `~/.agents/skills`, the cross-agent standard location.

const std = @import("std");

const Allocator = std.mem.Allocator;

/// Marker that identifies skill files we own. Uninstall refuses to delete
/// files without it so we never destroy a user's hand-written skill.
const ownership_marker = "managed by maxx-agent-hook";

/// Markers written by older releases; still count as ours.
const legacy_madmaxx_ownership_marker = "managed by madmaxx-agent-hook";
const legacy_ghostty_ownership_marker = "managed by ghostty-agent-hook";
const legacy_ownership_markers = [_][]const u8{
    legacy_madmaxx_ownership_marker,
    legacy_ghostty_ownership_marker,
};

/// Skill directory names used by older releases of the `maxx-tabs` skill.
/// Install and uninstall remove them (when we own them) so upgrades don't
/// leave stale copies behind.
const legacy_tabs_skill_dir_names = [_][]const u8{
    "madmaxx-tabs",
};

/// A bundled skill: the directory it installs into, its embedded `SKILL.md`
/// content, and any old directory names a prior release used for it.
pub const Skill = struct {
    dir_name: []const u8,
    content: []const u8,
    legacy_dir_names: []const []const u8 = &.{},
};

pub const tabs_skill: Skill = .{
    .dir_name = "maxx-tabs",
    .content = @embedFile("skill/SKILL.md"),
    .legacy_dir_names = &legacy_tabs_skill_dir_names,
};

pub const supervisor_skill: Skill = .{
    .dir_name = "maxx-supervisor-workflows",
    .content = @embedFile("skill/supervisor.md"),
};

/// Every skill we install. Order is install order.
pub const skills = [_]Skill{ tabs_skill, supervisor_skill };

// Back-compat aliases for callers/tests that referenced the single-skill names.
pub const skill_dir_name = tabs_skill.dir_name;
pub const skill_content = tabs_skill.content;

fn isOwnedContent(content: []const u8) bool {
    if (std.mem.indexOf(u8, content, ownership_marker) != null) return true;
    for (legacy_ownership_markers) |marker| {
        if (std.mem.indexOf(u8, content, marker) != null) return true;
    }
    return false;
}

pub fn installClaude(alloc: Allocator) !void {
    const root = try claudeSkillsRoot(alloc);
    defer alloc.free(root);
    try installAll(alloc, root, "Claude Code skill installed at ");
}

pub fn uninstallClaude(alloc: Allocator) !void {
    const root = try claudeSkillsRoot(alloc);
    defer alloc.free(root);
    try uninstallAll(alloc, root, "Claude Code skill removed from ");
}

pub fn installCodex(alloc: Allocator) !void {
    const root = try agentsSkillsRoot(alloc);
    defer alloc.free(root);
    try installAll(alloc, root, "Codex skill installed at ");
}

pub fn uninstallCodex(alloc: Allocator) !void {
    const root = try agentsSkillsRoot(alloc);
    defer alloc.free(root);
    try uninstallAll(alloc, root, "Codex skill removed from ");
}

/// Writes every bundled skill under `skills_root`. A foreign (not-ours) file at
/// one skill's path is skipped without clobbering it; the others still install,
/// and the foreign collision is reported once every skill has been attempted.
fn installAll(alloc: Allocator, skills_root: []const u8, prefix: []const u8) !void {
    var first_err: ?anyerror = null;
    for (&skills) |skill| {
        const path = writeSkill(alloc, skills_root, skill) catch |err| switch (err) {
            error.ForeignSkillExists => {
                if (first_err == null) first_err = err;
                continue;
            },
            else => return err,
        };
        defer alloc.free(path);
        try printStatus(prefix, path);
    }
    if (first_err) |err| return err;
}

/// Removes every bundled skill we own under `skills_root`. A foreign file at a
/// skill's path is left intact and reported once the rest have been removed.
fn uninstallAll(alloc: Allocator, skills_root: []const u8, prefix: []const u8) !void {
    var first_err: ?anyerror = null;
    for (&skills) |skill| {
        const path = removeSkill(alloc, skills_root, skill) catch |err| switch (err) {
            error.ForeignSkillExists => {
                if (first_err == null) first_err = err;
                continue;
            },
            else => return err,
        };
        defer alloc.free(path);
        try printStatus(prefix, path);
    }
    if (first_err) |err| return err;
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

/// Writes `skill` under `skills_root` and returns the SKILL.md path.
/// Refuses to overwrite a same-named skill we don't own.
pub fn writeSkill(alloc: Allocator, skills_root: []const u8, skill: Skill) ![]const u8 {
    const dir_path = try std.fs.path.join(alloc, &.{ skills_root, skill.dir_name });
    defer alloc.free(dir_path);
    const file_path = try std.fs.path.join(alloc, &.{ dir_path, "SKILL.md" });
    errdefer alloc.free(file_path);

    if (readFileAllocIfExists(alloc, file_path)) |existing| {
        defer alloc.free(existing);
        if (existing.len > 0 and !isOwnedContent(existing)) {
            return error.ForeignSkillExists;
        }
    } else |err| return err;

    try std.fs.cwd().makePath(dir_path);
    const file = try std.fs.createFileAbsolute(file_path, .{});
    defer file.close();
    try file.writeAll(skill.content);

    try removeLegacySkill(alloc, skills_root, skill);

    return file_path;
}

/// Removes `skill` under `skills_root` if we own it and returns the SKILL.md
/// path. Removing an absent skill succeeds.
pub fn removeSkill(alloc: Allocator, skills_root: []const u8, skill: Skill) ![]const u8 {
    try removeLegacySkill(alloc, skills_root, skill);
    return try removeSkillDir(alloc, skills_root, skill.dir_name);
}

/// Removes any old-named installs of `skill` we own. A hand-written skill that
/// happens to use an old name is left alone.
fn removeLegacySkill(alloc: Allocator, skills_root: []const u8, skill: Skill) !void {
    for (skill.legacy_dir_names) |dir_name| {
        if (removeSkillDir(alloc, skills_root, dir_name)) |path| {
            alloc.free(path);
        } else |err| switch (err) {
            error.ForeignSkillExists => {},
            else => return err,
        }
    }
}

fn removeSkillDir(alloc: Allocator, skills_root: []const u8, dir_name: []const u8) ![]const u8 {
    const dir_path = try std.fs.path.join(alloc, &.{ skills_root, dir_name });
    defer alloc.free(dir_path);
    const file_path = try std.fs.path.join(alloc, &.{ dir_path, "SKILL.md" });
    errdefer alloc.free(file_path);

    const existing = try readFileAllocIfExists(alloc, file_path);
    defer alloc.free(existing);
    if (existing.len == 0) return file_path;
    if (!isOwnedContent(existing)) {
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

test "every bundled skill has required frontmatter and ownership marker" {
    const testing = std.testing;
    for (&skills) |skill| {
        try testing.expect(std.mem.startsWith(u8, skill.content, "---\n"));
        try testing.expect(std.mem.indexOf(u8, skill.content, "description: ") != null);
        try testing.expect(std.mem.indexOf(u8, skill.content, ownership_marker) != null);
        const name_decl = try std.fmt.allocPrint(testing.allocator, "name: {s}", .{skill.dir_name});
        defer testing.allocator.free(name_decl);
        try testing.expect(std.mem.indexOf(u8, skill.content, name_decl) != null);
    }
}

test "tabs skill teaches new-tab; supervisor skill teaches the control API" {
    const testing = std.testing;
    try testing.expect(std.mem.indexOf(u8, tabs_skill.content, "maxx-agent-hook new-tab") != null);
    try testing.expect(std.mem.indexOf(u8, supervisor_skill.content, "maxx +control sessions create") != null);
    // The supervisor skill must keep the no-inference rule prominent.
    try testing.expect(std.mem.indexOf(u8, supervisor_skill.content, "no-inference") != null or
        std.mem.indexOf(u8, supervisor_skill.content, "no inference") != null);
    try testing.expect(std.mem.indexOf(u8, supervisor_skill.content, "not the workflow brain") != null);
}

test "write and remove every skill round trip" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const root = try tmp.dir.realpathAlloc(alloc, ".");
    defer alloc.free(root);

    for (&skills) |skill| {
        const written = try writeSkill(alloc, root, skill);
        defer alloc.free(written);

        const contents = try readFileAllocIfExists(alloc, written);
        defer alloc.free(contents);
        try testing.expectEqualStrings(skill.content, contents);

        // Reinstall over our own file succeeds.
        const rewritten = try writeSkill(alloc, root, skill);
        defer alloc.free(rewritten);

        const removed = try removeSkill(alloc, root, skill);
        defer alloc.free(removed);
        const after = try readFileAllocIfExists(alloc, removed);
        defer alloc.free(after);
        try testing.expectEqual(@as(usize, 0), after.len);

        // Removing an absent skill succeeds.
        const removed_again = try removeSkill(alloc, root, skill);
        defer alloc.free(removed_again);
    }
}

test "install writes both skills under one root" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const root = try tmp.dir.realpathAlloc(alloc, ".");
    defer alloc.free(root);

    try installAll(alloc, root, "installed at ");

    try tmp.dir.access("maxx-tabs/SKILL.md", .{});
    try tmp.dir.access("maxx-supervisor-workflows/SKILL.md", .{});

    try uninstallAll(alloc, root, "removed from ");
    try testing.expectError(error.FileNotFound, tmp.dir.access("maxx-tabs/SKILL.md", .{}));
    try testing.expectError(error.FileNotFound, tmp.dir.access("maxx-supervisor-workflows/SKILL.md", .{}));
}

test "write and remove refuse foreign skill files" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.makePath(tabs_skill.dir_name);
    const foreign = "---\nname: maxx-tabs\n---\nuser-authored skill\n";
    try tmp.dir.writeFile(.{
        .sub_path = tabs_skill.dir_name ++ "/SKILL.md",
        .data = foreign,
    });

    const root = try tmp.dir.realpathAlloc(alloc, ".");
    defer alloc.free(root);

    try testing.expectError(error.ForeignSkillExists, writeSkill(alloc, root, tabs_skill));
    try testing.expectError(error.ForeignSkillExists, removeSkill(alloc, root, tabs_skill));

    const skill_path = try std.fs.path.join(alloc, &.{ root, tabs_skill.dir_name, "SKILL.md" });
    defer alloc.free(skill_path);
    const contents = try readFileAllocIfExists(alloc, skill_path);
    defer alloc.free(contents);
    try testing.expectEqualStrings(foreign, contents);
}

test "install still writes other skills when one path is foreign" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    // A hand-written file squats on the supervisor skill's directory.
    try tmp.dir.makePath(supervisor_skill.dir_name);
    const foreign = "---\nname: maxx-supervisor-workflows\n---\nuser-authored skill\n";
    try tmp.dir.writeFile(.{
        .sub_path = supervisor_skill.dir_name ++ "/SKILL.md",
        .data = foreign,
    });

    const root = try tmp.dir.realpathAlloc(alloc, ".");
    defer alloc.free(root);

    // Install reports the collision but still writes the non-foreign skill...
    try testing.expectError(error.ForeignSkillExists, installAll(alloc, root, "installed at "));
    try tmp.dir.access("maxx-tabs/SKILL.md", .{});

    // ...and never clobbers the foreign file.
    const foreign_path = try std.fs.path.join(alloc, &.{ root, supervisor_skill.dir_name, "SKILL.md" });
    defer alloc.free(foreign_path);
    const contents = try readFileAllocIfExists(alloc, foreign_path);
    defer alloc.free(contents);
    try testing.expectEqualStrings(foreign, contents);
}

test "install migrates legacy-named skill dir we own" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.makePath("madmaxx-tabs");
    try tmp.dir.writeFile(.{
        .sub_path = "madmaxx-tabs/SKILL.md",
        .data = "---\nname: madmaxx-tabs\n---\n<!-- " ++ legacy_madmaxx_ownership_marker ++ " -->\n",
    });

    const root = try tmp.dir.realpathAlloc(alloc, ".");
    defer alloc.free(root);

    const written = try writeSkill(alloc, root, tabs_skill);
    defer alloc.free(written);

    // New skill exists, old-named dir is gone.
    try tmp.dir.access(tabs_skill.dir_name ++ "/SKILL.md", .{});
    try testing.expectError(error.FileNotFound, tmp.dir.access("madmaxx-tabs", .{}));
}
