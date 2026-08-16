use maxx_core::persist::{ChatProject, WorkspaceDocument};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub const LOCAL_HOST_ID: &str = "local";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostKind {
    Local,
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub id: String,
    pub name: String,
    pub kind: HostKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
}

impl HostInfo {
    pub fn local(name: impl Into<String>) -> Self {
        Self {
            id: LOCAL_HOST_ID.to_string(),
            name: name.into(),
            kind: HostKind::Local,
            address: None,
        }
    }

    pub fn remote(
        id: impl Into<String>,
        name: impl Into<String>,
        address: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            kind: HostKind::Remote,
            address: Some(address.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedProject {
    pub host_id: String,
    pub host_name: String,
    pub project: ChatProject,
}

/// In-memory view of this machine's workspace plus any attached remotes.
/// Detaching a remote drops only that snapshot; the local document is untouched.
#[derive(Debug, Clone)]
pub struct HostCatalog {
    local_host: HostInfo,
    local: WorkspaceDocument,
    remotes: Vec<(HostInfo, WorkspaceDocument)>,
}

impl HostCatalog {
    pub fn new(local_host: HostInfo, local: WorkspaceDocument) -> Self {
        Self {
            local_host,
            local,
            remotes: Vec::new(),
        }
    }

    pub fn local_host(&self) -> &HostInfo {
        &self.local_host
    }

    pub fn local_workspace(&self) -> &WorkspaceDocument {
        &self.local
    }

    pub fn local_workspace_mut(&mut self) -> &mut WorkspaceDocument {
        &mut self.local
    }

    pub fn hosts(&self) -> Vec<HostInfo> {
        let mut hosts = vec![self.local_host.clone()];
        hosts.extend(self.remotes.iter().map(|(info, _)| info.clone()));
        hosts
    }

    pub fn attach_remote(
        &mut self,
        host: HostInfo,
        workspace: WorkspaceDocument,
    ) -> Result<(), String> {
        if host.kind != HostKind::Remote || host.id == LOCAL_HOST_ID {
            return Err("A remote host is required".into());
        }
        if let Some(existing) = self.remotes.iter_mut().find(|(info, _)| info.id == host.id) {
            existing.0 = host;
            existing.1 = workspace;
            return Ok(());
        }
        self.remotes.push((host, workspace));
        Ok(())
    }

    pub fn detach_remote(&mut self, host_id: &str) -> Result<HostInfo, String> {
        if host_id == LOCAL_HOST_ID || host_id == self.local_host.id {
            return Err("The local host cannot be detached".into());
        }
        let index = self
            .remotes
            .iter()
            .position(|(info, _)| info.id == host_id)
            .ok_or_else(|| format!("Unknown host {host_id}"))?;
        Ok(self.remotes.remove(index).0)
    }

    pub fn workspace(&self, host_id: &str) -> Result<&WorkspaceDocument, String> {
        if host_id == LOCAL_HOST_ID || host_id == self.local_host.id {
            return Ok(&self.local);
        }
        self.remotes
            .iter()
            .find(|(info, _)| info.id == host_id)
            .map(|(_, workspace)| workspace)
            .ok_or_else(|| format!("Unknown host {host_id}"))
    }

    pub fn workspace_mut(&mut self, host_id: &str) -> Result<&mut WorkspaceDocument, String> {
        if host_id == LOCAL_HOST_ID || host_id == self.local_host.id {
            return Ok(&mut self.local);
        }
        self.remotes
            .iter_mut()
            .find(|(info, _)| info.id == host_id)
            .map(|(_, workspace)| workspace)
            .ok_or_else(|| format!("Unknown host {host_id}"))
    }

    pub fn host_owns_project(&self, host_id: &str, project_id: Uuid) -> Result<(), String> {
        let workspace = self.workspace(host_id)?;
        if workspace
            .projects
            .iter()
            .any(|project| project.id == project_id)
        {
            Ok(())
        } else {
            Err("That project is not on the requested host".into())
        }
    }

    pub fn host_owns_thread(
        &self,
        host_id: &str,
        project_id: Uuid,
        thread_id: Uuid,
    ) -> Result<(), String> {
        let workspace = self.workspace(host_id)?;
        let project = workspace
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .ok_or("Unknown project")?;
        if project.threads.iter().any(|thread| thread.id == thread_id) {
            Ok(())
        } else {
            Err("That thread is not on the requested host".into())
        }
    }
}

pub fn hosted_projects(catalog: &HostCatalog) -> Vec<HostedProject> {
    let mut projects = Vec::new();
    for project in &catalog.local.projects {
        projects.push(HostedProject {
            host_id: catalog.local_host.id.clone(),
            host_name: catalog.local_host.name.clone(),
            project: project.clone(),
        });
    }
    for (info, workspace) in &catalog.remotes {
        for project in &workspace.projects {
            projects.push(HostedProject {
                host_id: info.id.clone(),
                host_name: info.name.clone(),
                project: project.clone(),
            });
        }
    }
    projects
}

pub fn apply_add_project(workspace: &mut WorkspaceDocument, folder_path: String) -> ChatProject {
    deduplicate_project_folders(workspace);
    if let Some(existing) = workspace
        .projects
        .iter()
        .find(|project| project.folder_path == folder_path)
    {
        return existing.clone();
    }

    let project = ChatProject {
        id: Uuid::new_v4(),
        folder_path,
        threads: Vec::new(),
    };
    workspace.projects.push(project.clone());
    project
}

/// Keep one authoritative project record for each folder on a host. Duplicate
/// records are folded into the first record so their chats remain reachable.
pub fn deduplicate_project_folders(workspace: &mut WorkspaceDocument) -> usize {
    let mut retained = Vec::<ChatProject>::with_capacity(workspace.projects.len());
    let mut project_index_by_path = HashMap::<String, usize>::new();
    let mut removed = 0;

    for mut project in std::mem::take(&mut workspace.projects) {
        if let Some(&index) = project_index_by_path.get(&project.folder_path) {
            let existing = &mut retained[index];
            let mut known_thread_ids = existing
                .threads
                .iter()
                .map(|thread| thread.id)
                .collect::<HashSet<_>>();
            existing.threads.extend(
                project
                    .threads
                    .drain(..)
                    .filter(|thread| known_thread_ids.insert(thread.id)),
            );
            removed += 1;
        } else {
            project_index_by_path.insert(project.folder_path.clone(), retained.len());
            retained.push(project);
        }
    }

    workspace.projects = retained;
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_workspace(folder: &str) -> WorkspaceDocument {
        let mut workspace = WorkspaceDocument::default();
        workspace.projects.push(ChatProject {
            id: Uuid::new_v4(),
            folder_path: folder.into(),
            threads: Vec::new(),
        });
        workspace
    }

    #[test]
    fn attach_shows_both_workspaces_and_detach_leaves_local_bytes_unchanged() {
        let local = sample_workspace("/Users/scott/local-project");
        let local_bytes = serde_json::to_vec(&local).unwrap();
        let mut catalog = HostCatalog::new(HostInfo::local("This Mac"), local.clone());
        let remote = sample_workspace("/Users/scott/mini-project");
        catalog
            .attach_remote(
                HostInfo::remote("mini", "Scott’s Mac mini", "127.0.0.1:7422"),
                remote.clone(),
            )
            .unwrap();

        let visible = hosted_projects(&catalog);
        assert_eq!(visible.len(), 2);
        assert_eq!(visible[0].host_id, LOCAL_HOST_ID);
        assert_eq!(visible[0].project.folder_path, "/Users/scott/local-project");
        assert_eq!(visible[1].host_id, "mini");
        assert_eq!(visible[1].project.folder_path, "/Users/scott/mini-project");

        catalog.detach_remote("mini").unwrap();
        assert!(hosted_projects(&catalog)
            .iter()
            .all(|item| item.host_id == LOCAL_HOST_ID));
        assert_eq!(
            serde_json::to_vec(catalog.local_workspace()).unwrap(),
            local_bytes
        );
        assert_eq!(catalog.local_workspace(), &local);
    }

    #[test]
    fn mutation_on_host_a_is_not_applied_on_host_b() {
        let mut catalog =
            HostCatalog::new(HostInfo::local("This Mac"), sample_workspace("/tmp/local"));
        catalog
            .attach_remote(
                HostInfo::remote("mini", "Mini", "100.64.0.2:7422"),
                sample_workspace("/tmp/mini"),
            )
            .unwrap();
        let local_before = catalog.local_workspace().clone();
        apply_add_project(
            catalog.workspace_mut("mini").unwrap(),
            "/tmp/mini/other".into(),
        );
        assert_eq!(catalog.local_workspace(), &local_before);
        assert_eq!(catalog.workspace("mini").unwrap().projects.len(), 2);
        assert!(catalog
            .host_owns_project("mini", catalog.workspace("mini").unwrap().projects[1].id)
            .is_ok());
        assert!(catalog
            .host_owns_project(
                LOCAL_HOST_ID,
                catalog.workspace("mini").unwrap().projects[1].id
            )
            .is_err());
    }

    #[test]
    fn adding_a_folder_twice_returns_the_existing_project() {
        let mut workspace = WorkspaceDocument::default();
        let first = apply_add_project(&mut workspace, "/tmp/repo".into());
        let mut existing = first.clone();
        existing.threads.push(maxx_core::persist::ChatThread::new(
            "Existing chat".into(),
            maxx_core::contract::ChatProvider::Codex,
            "gpt-5".into(),
        ));
        workspace.projects[0] = existing.clone();

        let second = apply_add_project(&mut workspace, "/tmp/repo".into());

        assert_eq!(workspace.projects.len(), 1);
        assert_eq!(second.id, first.id);
        assert_eq!(second.threads, existing.threads);
    }

    #[test]
    fn duplicate_folder_records_are_collapsed_without_losing_chats() {
        let first_thread = maxx_core::persist::ChatThread::new(
            "First chat".into(),
            maxx_core::contract::ChatProvider::Codex,
            "gpt-5".into(),
        );
        let second_thread = maxx_core::persist::ChatThread::new(
            "Second chat".into(),
            maxx_core::contract::ChatProvider::Codex,
            "gpt-5".into(),
        );
        let first_id = Uuid::new_v4();
        let mut workspace = WorkspaceDocument {
            projects: vec![
                ChatProject {
                    id: first_id,
                    folder_path: "/tmp/repo".into(),
                    threads: vec![first_thread.clone()],
                },
                ChatProject {
                    id: Uuid::new_v4(),
                    folder_path: "/tmp/repo".into(),
                    threads: vec![first_thread, second_thread.clone()],
                },
            ],
            ..Default::default()
        };

        assert_eq!(deduplicate_project_folders(&mut workspace), 1);
        assert_eq!(workspace.projects.len(), 1);
        assert_eq!(workspace.projects[0].id, first_id);
        assert_eq!(workspace.projects[0].threads.len(), 2);
        assert!(workspace.projects[0]
            .threads
            .iter()
            .any(|thread| thread.id == second_thread.id));
    }

    #[test]
    fn same_folder_name_on_different_hosts_remains_distinct() {
        let mut catalog =
            HostCatalog::new(HostInfo::local("This Mac"), WorkspaceDocument::default());
        apply_add_project(
            catalog.local_workspace_mut(),
            "/Users/scott/local/browser-annotations".into(),
        );
        catalog
            .attach_remote(
                HostInfo::remote("mini", "Mac mini", "100.64.0.2:7422"),
                WorkspaceDocument::default(),
            )
            .unwrap();
        apply_add_project(
            catalog.workspace_mut("mini").unwrap(),
            "/Users/scott/mini/browser-annotations".into(),
        );

        let visible = hosted_projects(&catalog);
        assert_eq!(visible.len(), 2);
        assert_eq!(
            visible[0].project.folder_path,
            "/Users/scott/local/browser-annotations"
        );
        assert_eq!(
            visible[1].project.folder_path,
            "/Users/scott/mini/browser-annotations"
        );
        assert_ne!(visible[0].project.id, visible[1].project.id);
    }
}
