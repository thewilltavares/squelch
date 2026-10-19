package audio

import (
	"path/filepath"
	"strings"
)

// OctetStream is the MIME type stored for audio whose format was not known
// at ingest. Browsers vary on it: Chrome sniffs the bytes and plays them,
// but iOS Safari refuses to play an <audio> source labelled this way.
const OctetStream = "application/octet-stream"

// MIMEFromExt maps a file extension (including leading dot) to an audio MIME
// type, or OctetStream when it is not a known audio format.
func MIMEFromExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".mp3":
		return "audio/mpeg"
	case ".wav":
		return "audio/wav"
	case ".m4a":
		return "audio/mp4"
	case ".aac":
		return "audio/aac"
	case ".ogg":
		return "audio/ogg"
	case ".flac":
		return "audio/flac"
	case ".opus":
		return "audio/opus"
	default:
		return OctetStream
	}
}

// ResolveMIME returns the type to serve a stored call's audio with: stored,
// unless it is empty or OctetStream, in which case the type implied by
// path's extension.
//
// Uploaders commonly send the audio part as application/octet-stream
// (trunk-recorder's rdioscanner uploader does), so calls ingested that way
// carry it in the database. Resolving at serve time makes those calls
// playable without rewriting their rows.
func ResolveMIME(stored, path string) string {
	if stored != "" && stored != OctetStream {
		return stored
	}
	return MIMEFromExt(filepath.Ext(path))
}
