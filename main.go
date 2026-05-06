package main

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const maxSaveSize = 1 << 20 // 1MB per save file

// safeUserOrGame: strict — used for trusted server-side path components.
var safeUserOrGame = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// validFile: permissive — allows spaces, apostrophes, parens, etc.
// Rejects path separators, NUL, leading dot, and the special "." / "..".
func validFile(name string) bool {
	if name == "" || name == "." || name == ".." {
		return false
	}
	if strings.HasPrefix(name, ".") {
		return false
	}
	if strings.ContainsAny(name, "/\\\x00") {
		return false
	}
	return true
}

type saveInfo struct {
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"` // unix milliseconds
}

type handler struct{ dataDir string }

func main() {
	dataDir := envOr("PARCHMENT_SAVES_DIR", "/data")
	addr := envOr("PARCHMENT_SAVES_ADDR", "127.0.0.1:8080")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatalf("mkdir %s: %v", dataDir, err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/saves/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok"))
	})
	mux.Handle("/api/saves/", &handler{dataDir: dataDir})

	log.Printf("parchment-saves listening on %s, data=%s", addr, dataDir)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	user := r.Header.Get("X-Authentik-Username")

	if r.URL.Path == "/api/saves/whoami" {
		if user == "" {
			http.Error(w, "unauthenticated", http.StatusUnauthorized)
			return
		}
		writeJSON(w, map[string]string{"user": user})
		return
	}

	if user == "" {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	if !safeUserOrGame.MatchString(user) {
		http.Error(w, "bad user", http.StatusBadRequest)
		return
	}

	rest := strings.TrimPrefix(r.URL.Path, "/api/saves/")
	parts := splitPath(rest)
	if len(parts) == 0 || len(parts) > 2 {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	for i, p := range parts {
		dec, err := url.PathUnescape(p)
		if err != nil {
			http.Error(w, "bad path encoding", http.StatusBadRequest)
			return
		}
		parts[i] = dec
	}

	game := parts[0]
	if !safeUserOrGame.MatchString(game) {
		http.Error(w, "bad game", http.StatusBadRequest)
		return
	}

	if len(parts) == 1 {
		if r.Method != http.MethodGet {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		h.list(w, user, game)
		return
	}

	file := parts[1]
	if !validFile(file) {
		http.Error(w, "bad file", http.StatusBadRequest)
		return
	}
	p := filepath.Join(h.dataDir, user, game, file)

	switch r.Method {
	case http.MethodGet:
		h.read(w, p)
	case http.MethodHead:
		h.head(w, p)
	case http.MethodPut:
		h.write(w, r, p)
	case http.MethodDelete:
		h.del(w, p)
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func splitPath(p string) []string {
	out := make([]string, 0, 2)
	for _, s := range strings.Split(p, "/") {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func (h *handler) list(w http.ResponseWriter, user, game string) {
	dir := filepath.Join(h.dataDir, user, game)
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		writeJSON(w, []saveInfo{})
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]saveInfo, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, saveInfo{
			Name:  e.Name(),
			Size:  info.Size(),
			Mtime: info.ModTime().UnixMilli(),
		})
	}
	writeJSON(w, out)
}

func (h *handler) read(w http.ResponseWriter, p string) {
	f, err := os.Open(p)
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	if _, err := io.Copy(w, f); err != nil {
		log.Printf("read copy %s: %v", p, err)
	}
}

func (h *handler) head(w http.ResponseWriter, p string) {
	info, err := os.Stat(p)
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
}

func (h *handler) write(w http.ResponseWriter, r *http.Request, p string) {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	body := http.MaxBytesReader(w, r.Body, maxSaveSize)
	tmp := p + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if _, err := io.Copy(f, body); err != nil {
		f.Close()
		os.Remove(tmp)
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := os.Rename(tmp, p); err != nil {
		os.Remove(tmp)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *handler) del(w http.ResponseWriter, p string) {
	err := os.Remove(p)
	if errors.Is(err, os.ErrNotExist) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("json encode: %v", err)
	}
}
