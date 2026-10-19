package audio

import "testing"

func TestMIMEFromExt(t *testing.T) {
	cases := []struct {
		ext  string
		want string
	}{
		{".mp3", "audio/mpeg"},
		{".MP3", "audio/mpeg"},
		{".wav", "audio/wav"},
		{".m4a", "audio/mp4"},
		{".aac", "audio/aac"},
		{".ogg", "audio/ogg"},
		{".flac", "audio/flac"},
		{".opus", "audio/opus"},
		{".xyz", OctetStream},
		{"", OctetStream},
	}

	for _, tc := range cases {
		t.Run(tc.ext, func(t *testing.T) {
			got := MIMEFromExt(tc.ext)
			if got != tc.want {
				t.Errorf("MIMEFromExt(%q) = %q, want %q", tc.ext, got, tc.want)
			}
		})
	}
}

func TestResolveMIME(t *testing.T) {
	cases := []struct {
		name   string
		stored string
		path   string
		want   string
	}{
		{"stored type kept", "audio/mpeg", "2026/10/18/call.m4a", "audio/mpeg"},
		{"octet-stream resolved from extension", OctetStream, "2026/10/18/call.m4a", "audio/mp4"},
		{"empty resolved from extension", "", "call.WAV", "audio/wav"},
		{"unknown extension stays octet-stream", OctetStream, "call.bin", OctetStream},
		{"no extension stays octet-stream", "", "call", OctetStream},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveMIME(tc.stored, tc.path)
			if got != tc.want {
				t.Errorf("ResolveMIME(%q, %q) = %q, want %q", tc.stored, tc.path, got, tc.want)
			}
		})
	}
}
