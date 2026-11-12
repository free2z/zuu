//! Linux WebKitGTK fixture using the shipping window factory and navigation
//! plugin. Run only through scripts/tor-navigation-fixture.sh (isolated DNS).
#[cfg(target_os = "linux")]
#[path = "../src/navigation.rs"]
mod navigation;

#[cfg(target_os = "linux")]
mod fixture {
    use std::{
        io::{Read, Write},
        net::{TcpListener, UdpSocket},
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc, Mutex,
        },
        time::Duration,
    };
    use tauri::Manager;
    #[derive(Default)]
    pub struct Report {
        local_ipc: AtomicUsize,
    }
    #[tauri::command]
    fn fixture_report(report: tauri::State<'_, Arc<Report>>, local_route: bool) {
        assert!(local_route, "same-origin routing must remain functional");
        report.local_ipc.fetch_add(1, Ordering::SeqCst);
    }
    pub fn run() {
        assert_eq!(
            std::env::var("ZUULI_NAVIGATION_FIXTURE_NAMESPACE").as_deref(),
            Ok("1")
        );
        assert!(std::fs::read_to_string("/etc/resolv.conf")
            .unwrap()
            .contains("nameserver 127.0.0.1"));
        let args: Vec<_> = std::env::args().collect();
        let control = args.get(1).map(String::as_str) == Some("control");
        let case = args
            .get(2)
            .map(String::as_str)
            .unwrap_or("assign")
            .to_owned();
        assert!([
            "assign",
            "anchor",
            "popup",
            "blank-popup",
            "redirect",
            "form"
        ]
        .contains(&case.as_str()));
        let running = Arc::new(AtomicBool::new(true));
        let dns_count = Arc::new(AtomicUsize::new(0));
        let tcp_count = Arc::new(AtomicUsize::new(0));
        let dns = UdpSocket::bind("127.0.0.1:53").unwrap();
        dns.set_nonblocking(true).unwrap();
        let dns_task = {
            let running = running.clone();
            let count = dns_count.clone();
            std::thread::spawn(move || {
                let mut buf = [0; 512];
                while running.load(Ordering::SeqCst) {
                    match dns.recv_from(&mut buf) {
                        Ok((n, peer)) => {
                            count.fetch_add(1, Ordering::SeqCst);
                            let mut end = 12;
                            while end < n && buf[end] != 0 {
                                end += 1 + buf[end] as usize;
                            }
                            end += 5;
                            assert!(end <= n);
                            let ipv4 = buf[end - 4..end - 2] == [0, 1];
                            let mut answer = buf[..end].to_vec();
                            answer[2] = 0x81;
                            answer[3] = 0x80;
                            answer[6..8].copy_from_slice(&u16::from(ipv4).to_be_bytes());
                            if ipv4 {
                                answer.extend_from_slice(&[
                                    0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, 127, 0, 0, 1,
                                ]);
                            }
                            dns.send_to(&answer, peer).unwrap();
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(e) => panic!("DNS fixture: {e}"),
                    }
                }
            })
        };
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        server.set_nonblocking(true).unwrap();
        let tcp_task = {
            let running = running.clone();
            let count = tcp_count.clone();
            std::thread::spawn(move || {
                while running.load(Ordering::SeqCst) {
                    match server.accept() {
                        Ok((mut socket, _)) => {
                            count.fetch_add(1, Ordering::SeqCst);
                            socket
                                .set_read_timeout(Some(Duration::from_secs(1)))
                                .unwrap();
                            let mut bytes = [0; 4096];
                            let _ = socket.read(&mut bytes);
                            let _=socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\nContent-Type: text/html\r\nConnection: close\r\n\r\nremote fixture!");
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(e) => panic!("TCP fixture: {e}"),
                    }
                }
            })
        };
        let remote = format!("https://navigation.fixture.test:{port}/leak");
        let attempt = match case.as_str() {
            "assign" => format!(
                "location.assign({});",
                serde_json::to_string(&remote).unwrap()
            ),
            "anchor" => format!(
                "const a=document.createElement('a');a.href={};document.body.append(a);a.click();",
                serde_json::to_string(&remote).unwrap()
            ),
            "popup" => format!(
                "window.open({},'_blank');",
                serde_json::to_string(&remote).unwrap()
            ),
            "blank-popup" => format!(
                "const w=window.open('about:blank','_blank');if(w)w.location={};",
                serde_json::to_string(&remote).unwrap()
            ),
            "redirect" => "location.assign('/redirect');".to_owned(),
            "form" => format!("const f=document.createElement('form');f.method='POST';f.action={};document.body.append(f);f.submit();",serde_json::to_string(&remote).unwrap()),
            _ => unreachable!(),
        };
        let script=format!("(async()=>{{history.pushState({{}},'', '/wallet#fixture');await window.__TAURI_INTERNALS__.invoke('fixture_report',{{localRoute:location.pathname==='/wallet'}});{attempt}}})()");
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = config["app"]["security"]["csp"]
            .as_str()
            .unwrap()
            .to_owned();
        let dev_count = Arc::new(AtomicUsize::new(0));
        let dev_server = tiny_http::Server::http("127.0.0.1:1423").unwrap();
        let dev_task = {
            let running = running.clone();
            let script = script.clone();
            let csp = csp.clone();
            let remote = remote.clone();
            let count = dev_count.clone();
            std::thread::spawn(move || {
                while running.load(Ordering::SeqCst) {
                    if let Some(request) =
                        dev_server.recv_timeout(Duration::from_millis(50)).unwrap()
                    {
                        count.fetch_add(1, Ordering::SeqCst);
                        let (status,mime,body)=match request.url() {
                        "/probe.js"=>(200,"text/javascript",script.as_bytes().to_vec()),
                        "/redirect"=>(302,"text/html",vec![]),
                        _=>(200,"text/html",b"<!doctype html><body>local development fixture<script src='/probe.js'></script></body>".to_vec()),
                    };
                        let mut response = tiny_http::Response::from_data(body)
                            .with_status_code(status)
                            .with_header(
                                tiny_http::Header::from_bytes("Content-Type", mime).unwrap(),
                            )
                            .with_header(
                                tiny_http::Header::from_bytes(
                                    "Content-Security-Policy",
                                    csp.as_str(),
                                )
                                .unwrap(),
                            );
                        if status == 302 {
                            response = response.with_header(
                                tiny_http::Header::from_bytes("Location", remote.as_str()).unwrap(),
                            );
                        }
                        let _ = request.respond(response);
                    }
                }
            })
        };
        let report = Arc::new(Report::default());
        let result = Arc::new(Mutex::new(None));
        let capture = result.clone();
        let mut builder=tauri::Builder::default().manage(report.clone()).invoke_handler(tauri::generate_handler![fixture_report])
            .register_uri_scheme_protocol("tauri",move|_,request| {
                let (status,mime,body,location)=match request.uri().path() {
                    "/probe.js"=>(200,"text/javascript",script.as_bytes().to_vec(),None),
                    "/redirect"=>(302,"text/html",vec![],Some(remote.clone())),
                    _=>(200,"text/html",b"<!doctype html><body>local fixture<script src='/probe.js'></script></body>".to_vec(),None),
                };
                let mut response=tauri::http::Response::builder().status(status).header("Content-Type",mime).header("Content-Security-Policy",&csp);
                if let Some(location)=location {response=response.header("Location",location);}
                response.body(body).unwrap()
            });
        if !control {
            builder = builder.plugin(super::navigation::plugin());
        }
        let mut context = tauri::generate_context!();
        context.config_mut().identifier = "cash.free2z.zuuli.navigation-fixture".into();
        context.config_mut().app.windows[0].incognito = true;
        context.config_mut().build.dev_url = if case == "redirect" {
            Some("http://127.0.0.1:1423".parse().unwrap())
        } else {
            None
        };
        let app = builder
            .setup(move |app| {
                if control {
                    tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Allow)
                        .build()?;
                } else {
                    super::navigation::create_main(app.handle())?;
                }
                Ok(())
            })
            .build(context)
            .unwrap();
        let code = app.run_return(move |app, event| {
            if matches!(event, tauri::RunEvent::Ready) {
                let app = app.clone();
                let capture = capture.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(3));
                    let url = app.get_webview_window("main").unwrap().url().unwrap();
                    let windows = app.webview_windows().len();
                    *capture.lock().unwrap() = Some((url, windows));
                    app.exit(0);
                });
            }
        });
        running.store(false, Ordering::SeqCst);
        dns_task.join().unwrap();
        tcp_task.join().unwrap();
        dev_task.join().unwrap();
        if case == "redirect" {
            assert!(
                dev_count.load(Ordering::SeqCst) >= 2,
                "exact development origin must load and preserve IPC"
            );
        }
        assert_eq!(code, 0);
        let dns = dns_count.load(Ordering::SeqCst);
        let tcp = tcp_count.load(Ordering::SeqCst);
        let (url, windows) = result.lock().unwrap().take().unwrap();
        assert!(
            report.local_ipc.load(Ordering::SeqCst) > 0,
            "local routing/IPC positive control must run before navigation"
        );
        eprintln!("observed before assertions: control={control} case={case} DNS={dns} TCP={tcp} url={url}");
        if control {
            assert!(
                dns > 0 && tcp > 0,
                "negative control must dispatch live DNS and TCP: {dns}/{tcp}"
            );
        } else {
            assert_eq!(
                (dns, tcp),
                (0, 0),
                "native policy must cancel before DNS/TCP"
            );
            assert!(super::navigation::allowed(&url));
            assert_eq!(windows, 1);
        }
        eprintln!("navigation fixture mode={} case={case} DNS={dns} TCP={tcp} localIPC={} managedWebViews={windows} finalURL={url}",if control {"control"} else {"native-gate"},report.local_ipc.load(Ordering::SeqCst));
    }
}
#[cfg(target_os = "linux")]
fn main() {
    fixture::run()
}
#[cfg(not(target_os = "linux"))]
fn main() {
    panic!("navigation probe requires isolated Linux WebKitGTK")
}
