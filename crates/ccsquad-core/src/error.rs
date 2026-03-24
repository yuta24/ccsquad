use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(String),

    #[error("Config error: {0}")]
    Config(String),

    #[error("Job error: {0}")]
    Job(String),

    #[error("Workflow error: {0}")]
    Workflow(String),

    #[error("Memory error: {0}")]
    Memory(String),

    #[error("Index error: {0}")]
    Index(String),
}

pub type Result<T> = std::result::Result<T, Error>;
