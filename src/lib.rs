use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn check_wasm_status() -> String {
    "WASM module initialized successfully".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wasm_status() {
        assert_eq!(check_wasm_status(), "WASM module initialized successfully");
    }
}
