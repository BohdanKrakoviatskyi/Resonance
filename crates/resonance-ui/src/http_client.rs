use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use anyhow::anyhow;
use futures::future::BoxFuture;
use gpui_kit::http_client::{
    AsyncBody, HttpClient, RedirectPolicy, Request, Response, Url,
    http::{HeaderName, HeaderValue, StatusCode},
};

static TOKIO_RT: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("resonance-tokio")
        .build()
        .expect("tokio runtime")
});

static SHARED_HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .build()
        .expect("reqwest client")
});

static IMAGE_BYTES_CACHE: LazyLock<Mutex<HashMap<String, Arc<[u8]>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn tokio_runtime() -> &'static tokio::runtime::Runtime {
    &TOKIO_RT
}

pub fn shared_reqwest() -> reqwest::Client {
    SHARED_HTTP.clone()
}

pub async fn fetch_image_bytes_cached(url: &str) -> anyhow::Result<Arc<[u8]>> {
    if url.is_empty() {
        return Err(anyhow!("empty image url"));
    }
    if let Ok(cache) = IMAGE_BYTES_CACHE.lock()
        && let Some(hit) = cache.get(url) {
            return Ok(hit.clone());
        }

    let bytes: Arc<[u8]> = if let Some(path) = url.strip_prefix("file://") {
        let data = tokio::fs::read(path).await?;
        Arc::from(data)
    } else if !url.starts_with("http://") && !url.starts_with("https://") {
        let data = tokio::fs::read(url).await?;
        Arc::from(data)
    } else {
        let resp = SHARED_HTTP.get(url).send().await?.error_for_status()?;
        let raw = resp.bytes().await?;
        Arc::from(raw.as_ref())
    };

    if let Ok(mut cache) = IMAGE_BYTES_CACHE.lock() {
        if cache.len() >= 256 {
            cache.clear();
        }
        cache.insert(url.to_string(), bytes.clone());
    }
    Ok(bytes)
}

pub struct ReqwestGpuiHttpClient {
    user_agent: HeaderValue,
}

impl Default for ReqwestGpuiHttpClient {
    fn default() -> Self {
        Self {
            user_agent: HeaderValue::from_static("Resonance/0.15.0"),
        }
    }
}

impl HttpClient for ReqwestGpuiHttpClient {
    fn user_agent(&self) -> Option<&HeaderValue> {
        Some(&self.user_agent)
    }

    fn proxy(&self) -> Option<&Url> {
        None
    }

    fn send(
        &self,
        req: Request<AsyncBody>,
    ) -> BoxFuture<'static, anyhow::Result<Response<AsyncBody>>> {
        let uri = req.uri().to_string();
        let method = reqwest::Method::from_bytes(req.method().as_str().as_bytes())
            .unwrap_or(reqwest::Method::GET);
        let headers = req.headers().clone();
        let follow = !matches!(
            req.extensions().get::<RedirectPolicy>(),
            Some(RedirectPolicy::NoFollow)
        );

        Box::pin(async move {
            let (tx, rx) = futures::channel::oneshot::channel();
            tokio_runtime().spawn(async move {
                let res = async {
                    let client = if follow {
                        SHARED_HTTP.clone()
                    } else {
                        reqwest::Client::builder()
                            .redirect(reqwest::redirect::Policy::none())
                            .timeout(Duration::from_secs(20))
                            .build()?
                    };

                    let mut builder = client.request(method.clone(), &uri);
                    for (k, v) in &headers {
                        if let (Ok(rk), Ok(rv)) = (
                            reqwest::header::HeaderName::from_bytes(k.as_str().as_bytes()),
                            reqwest::header::HeaderValue::from_bytes(v.as_bytes()),
                        ) {
                            builder = builder.header(rk, rv);
                        }
                    }

                    let resp = builder.send().await?;
                    let status = StatusCode::from_u16(resp.status().as_u16())
                        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                    let mut resp_builder = Response::builder().status(status);
                    for (k, v) in resp.headers() {
                        if let (Ok(hk), Ok(hv)) = (
                            HeaderName::from_bytes(k.as_str().as_bytes()),
                            HeaderValue::from_bytes(v.as_bytes()),
                        ) {
                            resp_builder = resp_builder.header(hk, hv);
                        }
                    }
                    let raw = resp.bytes().await?;
                    let out = resp_builder.body(AsyncBody::from_bytes(raw))?;
                    Ok::<_, anyhow::Error>(out)
                }
                .await;
                let _ = tx.send(res);
            });
            rx.await.map_err(|_| anyhow!("http worker cancelled"))?
        })
    }
}
