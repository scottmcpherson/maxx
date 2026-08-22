//! Port of `NativeJSONLineProcess`: a Maxx-owned child process speaking
//! newline-delimited JSON over stdio, with graceful interrupt (SIGINT) and
//! forced termination escalation.

use maxx_core::StreamingJsonLineBuffer;
use serde_json::Value;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex};

pub struct JsonLineProcess {
    pub lines: Mutex<mpsc::Receiver<Result<Vec<u8>, String>>>,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pid: Option<u32>,
}

pub struct LaunchSpec {
    pub executable: String,
    pub arguments: Vec<String>,
    pub working_directory: Option<String>,
    pub environment: std::collections::HashMap<String, String>,
}

impl JsonLineProcess {
    pub fn spawn(spec: &LaunchSpec) -> Result<Arc<Self>, String> {
        let mut command = Command::new(&spec.executable);
        command
            .args(&spec.arguments)
            .env_clear()
            .envs(&spec.environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = &spec.working_directory {
            command.current_dir(cwd);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Failed to launch {}: {e}", spec.executable))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let pid = child.id();

        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>(1024);
        if let Some(mut stdout) = stdout {
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut buffer = StreamingJsonLineBuffer::new();
                let mut chunk = [0u8; 16 * 1024];
                loop {
                    match stdout.read(&mut chunk).await {
                        Ok(0) => break,
                        Ok(n) => {
                            for line in buffer.append(&chunk[..n]) {
                                if tx.send(Ok(line)).await.is_err() {
                                    return;
                                }
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(Err(e.to_string())).await;
                            return;
                        }
                    }
                }
                if let Some(line) = buffer.finish() {
                    let _ = tx.send(Ok(line)).await;
                }
            });
        }
        // Drain stderr so the child never blocks on a full pipe; surface it in logs.
        if let Some(mut stderr) = stderr {
            tokio::spawn(async move {
                let mut chunk = [0u8; 8 * 1024];
                while let Ok(n) = stderr.read(&mut chunk).await {
                    if n == 0 {
                        break;
                    }
                    log::debug!("provider stderr: {}", String::from_utf8_lossy(&chunk[..n]));
                }
            });
        }

        Ok(Arc::new(Self {
            lines: Mutex::new(rx),
            stdin: Mutex::new(stdin),
            child: Mutex::new(Some(child)),
            pid,
        }))
    }

    pub async fn send(&self, value: &Value) -> Result<(), String> {
        let mut guard = self.stdin.lock().await;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| "provider stdin closed".to_string())?;
        let mut line = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        line.push(b'\n');
        stdin.write_all(&line).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())
    }

    /// Graceful interruption: SIGINT, mirroring the Swift registry's
    /// provider-native interruption escalation path.
    pub fn interrupt(&self) {
        if let Some(pid) = self.pid {
            unsafe {
                libc::kill(pid as i32, libc::SIGINT);
            }
        }
    }

    pub async fn shutdown(&self) {
        {
            let mut stdin = self.stdin.lock().await;
            *stdin = None; // close the pipe first so well-behaved CLIs exit
        }
        let mut guard = self.child.lock().await;
        if let Some(child) = guard.as_mut() {
            let graceful = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait());
            if graceful.await.is_err() {
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
        }
        *guard = None;
    }
}
