pub mod models;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

use tauri::{
    Manager, Runtime,
    plugin::{Builder, TauriPlugin},
};

pub use models::*;

#[cfg(desktop)]
pub use desktop::ResonanceMobile;
#[cfg(mobile)]
pub use mobile::ResonanceMobile;

pub trait ResonanceMobileExt<R: Runtime> {
    fn resonance_mobile(&self) -> &ResonanceMobile<R>;
}

impl<R: Runtime, T: Manager<R>> ResonanceMobileExt<R> for T {
    fn resonance_mobile(&self) -> &ResonanceMobile<R> {
        self.state::<ResonanceMobile<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("resonance-mobile")
        .setup(|app, api| {
            #[cfg(mobile)]
            let bridge = mobile::init(app, api)?;
            #[cfg(desktop)]
            let bridge = desktop::init(app, api)?;
            app.manage(bridge);
            Ok(())
        })
        .build()
}
