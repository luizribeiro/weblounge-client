//! Resolves where an image upload goes and how it is authorized (design 31).

use crate::{
    RedactedSecret, UploadApproval, UploadAuthorization, UploadResolution,
    filehost::{self, UploadEndpoint},
    storage::KvBackend,
    upload_approvals::{self, ApprovalKey},
    upload_policy::{Address, Approval, CredentialKind, Release, release_credential},
};

/// The configured endpoint and the credential an upload to the network's file host may use.
#[derive(Clone)]
pub(crate) struct ConnectionIdentity {
    pub(crate) endpoint: String,
    pub(crate) credential: UploadCredential,
}

// papo never hands secrets back, so the engine keeps its own handle on the SASL PLAIN password.
#[derive(Clone)]
pub(crate) enum UploadCredential {
    Basic {
        account: String,
        password: papo::Secret,
    },
    HostBearer,
}

impl ConnectionIdentity {
    pub(crate) const fn hosted(endpoint: String) -> Self {
        Self {
            endpoint,
            credential: UploadCredential::HostBearer,
        }
    }

    #[cfg(test)]
    pub(crate) fn test_plain() -> Self {
        Self {
            endpoint: "wss://irc.example.org/socket".into(),
            credential: UploadCredential::Basic {
                account: "weblounge".into(),
                password: papo::Secret::new("weblounge-test"),
            },
        }
    }
}

/// A network's upload-relevant state, captured under the runtime lock.
pub(crate) struct UploadContext {
    pub(crate) identity: ConnectionIdentity,
    pub(crate) filehost: Option<UploadEndpoint>,
    pub(crate) online: bool,
}

pub(crate) async fn resolve<B: KvBackend>(
    storage: &B,
    context: UploadContext,
    requested: Option<UploadApproval>,
) -> UploadResolution {
    if !context.online {
        return UploadResolution::Offline;
    }
    let Some(filehost) = context.filehost else {
        return UploadResolution::Unavailable;
    };
    let identity = context.identity;
    let irc = filehost::endpoint_address(&identity.endpoint).unwrap_or(Address {
        host: String::new(),
        port: 0,
    });
    let (kind, approval, authorization) = match identity.credential {
        UploadCredential::Basic { account, password } => {
            let key = ApprovalKey {
                endpoint: identity.endpoint,
                authority: filehost.authority.clone(),
                account,
            };
            let approval = approval(storage, requested, &key).await;
            let header = basic_header(&key.account, &password);
            (
                CredentialKind::Basic,
                approval,
                UploadAuthorization::Basic { header },
            )
        }
        UploadCredential::HostBearer => (
            CredentialKind::Bearer,
            Approval::Absent,
            UploadAuthorization::HostBearer,
        ),
    };
    match release_credential(&irc, &filehost.address, kind, approval) {
        Release::Send => ready(filehost, authorization),
        Release::Ask => UploadResolution::ApprovalRequired {
            host: filehost.authority,
        },
        Release::Refuse => UploadResolution::OtherSite,
    }
}

fn ready(filehost: UploadEndpoint, authorization: UploadAuthorization) -> UploadResolution {
    UploadResolution::Ready {
        endpoint: filehost.url,
        authorization,
    }
}

// An approval counts only for the authority the engine resolved just now, so a stale or
// fabricated answer for another host never releases the password. Storage failures fall back
// to asking.
async fn approval<B: KvBackend>(
    storage: &B,
    requested: Option<UploadApproval>,
    key: &ApprovalKey,
) -> Approval {
    if let Some(requested) = requested.filter(|requested| requested.host == key.authority) {
        if requested.remember {
            let _ = upload_approvals::remember(storage, key.clone()).await;
        }
        return Approval::Granted;
    }
    if upload_approvals::is_remembered(storage, key)
        .await
        .unwrap_or(false)
    {
        Approval::Granted
    } else {
        Approval::Absent
    }
}

fn basic_header(account: &str, password: &papo::Secret) -> RedactedSecret {
    use base64::Engine;
    let token = base64::engine::general_purpose::STANDARD
        .encode(format!("{account}:{}", password.expose()));
    RedactedSecret::from(format!("Basic {token}"))
}

#[cfg(test)]
mod tests {
    use super::{ConnectionIdentity, UploadContext, UploadCredential, resolve};
    use crate::{
        RedactedSecret, UploadApproval, UploadAuthorization, UploadResolution,
        filehost::UploadEndpoint, storage::MemoryKv, upload_approvals,
    };

    fn plain(endpoint: &str) -> ConnectionIdentity {
        ConnectionIdentity {
            endpoint: endpoint.into(),
            credential: UploadCredential::Basic {
                account: "luiz".into(),
                password: papo::Secret::new("pässword"),
            },
        }
    }

    fn filehost(authority: &str) -> UploadEndpoint {
        UploadEndpoint {
            url: format!("https://{authority}/upload"),
            authority: authority.into(),
            address: crate::upload_policy::Address {
                host: authority.split(':').next().unwrap_or(authority).into(),
                port: authority
                    .split_once(':')
                    .map_or(443, |(_, port)| port.parse().expect("test port")),
            },
        }
    }

    fn context(identity: ConnectionIdentity, authority: Option<&str>) -> UploadContext {
        UploadContext {
            identity,
            filehost: authority.map(filehost),
            online: true,
        }
    }

    fn basic(endpoint: &str) -> UploadResolution {
        UploadResolution::Ready {
            endpoint: endpoint.into(),
            authorization: UploadAuthorization::Basic {
                header: RedactedSecret::from("Basic bHVpejpww6Rzc3dvcmQ="),
            },
        }
    }

    fn approval(host: &str, remember: bool) -> UploadApproval {
        UploadApproval {
            host: host.into(),
            remember,
        }
    }

    const IRC: &str = "wss://irc.example.org/socket";

    #[tokio::test]
    async fn offline_and_missing_filehosts_never_resolve() {
        let storage = MemoryKv::default();
        let mut offline = context(plain(IRC), Some("files.example.org"));
        offline.online = false;
        assert_eq!(
            resolve(&storage, offline, None).await,
            UploadResolution::Offline
        );
        assert_eq!(
            resolve(&storage, context(plain(IRC), None), None).await,
            UploadResolution::Unavailable
        );
    }

    #[tokio::test]
    async fn own_site_filehosts_get_the_basic_header() {
        let storage = MemoryKv::default();
        assert_eq!(
            resolve(
                &storage,
                context(plain(IRC), Some("files.example.org")),
                None
            )
            .await,
            basic("https://files.example.org/upload")
        );
    }

    #[tokio::test]
    async fn hosted_logins_ask_the_host_for_a_bearer() {
        let storage = MemoryKv::default();
        let hosted = || ConnectionIdentity::hosted(IRC.into());
        assert_eq!(
            resolve(&storage, context(hosted(), Some("files.example.org")), None).await,
            UploadResolution::Ready {
                endpoint: "https://files.example.org/upload".into(),
                authorization: UploadAuthorization::HostBearer,
            }
        );
        assert_eq!(
            resolve(
                &storage,
                context(hosted(), Some("files.elsewhere.test")),
                Some(approval("files.elsewhere.test", true))
            )
            .await,
            UploadResolution::OtherSite
        );
    }

    #[tokio::test]
    async fn foreign_filehosts_need_an_approval_for_that_host() {
        let storage = MemoryKv::default();
        let foreign = || context(plain(IRC), Some("files.elsewhere.test:8443"));
        let asks = UploadResolution::ApprovalRequired {
            host: "files.elsewhere.test:8443".into(),
        };
        assert_eq!(resolve(&storage, foreign(), None).await, asks);
        assert_eq!(
            resolve(
                &storage,
                foreign(),
                Some(approval("files.elsewhere.test", true))
            )
            .await,
            asks
        );
        assert_eq!(
            resolve(
                &storage,
                foreign(),
                Some(approval("files.elsewhere.test:8443", false))
            )
            .await,
            basic("https://files.elsewhere.test:8443/upload")
        );
        assert_eq!(resolve(&storage, foreign(), None).await, asks);
    }

    #[tokio::test]
    async fn remembered_approvals_cover_later_uploads_until_forgotten() {
        let storage = MemoryKv::default();
        let foreign = || context(plain(IRC), Some("files.elsewhere.test"));
        assert_eq!(
            resolve(
                &storage,
                foreign(),
                Some(approval("files.elsewhere.test", true))
            )
            .await,
            basic("https://files.elsewhere.test/upload")
        );
        assert_eq!(
            resolve(&storage, foreign(), None).await,
            basic("https://files.elsewhere.test/upload")
        );
        assert_eq!(
            resolve(
                &storage,
                context(plain(IRC), Some("cdn.elsewhere.test")),
                None
            )
            .await,
            UploadResolution::ApprovalRequired {
                host: "cdn.elsewhere.test".into()
            }
        );
        assert_eq!(
            resolve(
                &storage,
                context(
                    plain("wss://irc.other.test/socket"),
                    Some("files.elsewhere.test")
                ),
                None
            )
            .await,
            UploadResolution::ApprovalRequired {
                host: "files.elsewhere.test".into()
            }
        );

        upload_approvals::forget_all(&storage)
            .await
            .expect("forget");
        assert_eq!(
            resolve(&storage, foreign(), None).await,
            UploadResolution::ApprovalRequired {
                host: "files.elsewhere.test".into()
            }
        );
    }

    #[tokio::test]
    async fn the_header_never_appears_in_diagnostics() {
        let resolution = resolve(
            &MemoryKv::default(),
            context(plain(IRC), Some("files.example.org")),
            None,
        )
        .await;
        let UploadResolution::Ready { authorization, .. } = &resolution else {
            unreachable!("own-site uploads are ready")
        };
        assert!(matches!(authorization, UploadAuthorization::Basic { .. }));
        assert!(!format!("{resolution:?}").contains("bHVpejpww6Rzc3dvcmQ="));
        assert!(!format!("{resolution:?}").contains("pässword"));
    }
}
