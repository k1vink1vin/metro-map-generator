Attribute VB_Name = "ValidateTransfers"
Option Explicit

Private Const COORD_TOLERANCE As Double = 0.0000001

Private Function NormalizeStationName(ByVal value As Variant) As String
    NormalizeStationName = LCase$(Trim$(CStr(value)))
End Function

Public Sub ValidateTransferCoordinates()
    Dim ws As Worksheet
    Dim lastRow As Long
    Dim rowIndex As Long
    Dim stationName As String
    Dim stationId As String
    Dim latitude As Double
    Dim longitude As Double
    Dim info As Object
    Dim counts As Object
    Dim mismatches As Object
    Dim firstValue As Variant
    Dim mismatchCount As Long
    Dim transferRowCount As Long

    Set ws = ThisWorkbook.Worksheets("Stations")
    lastRow = ws.Cells(ws.Rows.Count, "A").End(xlUp).Row

    Set info = CreateObject("Scripting.Dictionary")
    Set counts = CreateObject("Scripting.Dictionary")
    Set mismatches = CreateObject("Scripting.Dictionary")

    If lastRow < 2 Then
        MsgBox "Stations sheet has no data.", vbExclamation
        Exit Sub
    End If

    ws.Range("A2:D" & lastRow).Interior.Pattern = xlNone

    For rowIndex = 2 To lastRow
        stationId = Trim$(CStr(ws.Cells(rowIndex, "A").Value))
        stationName = NormalizeStationName(ws.Cells(rowIndex, "B").Value)

        If stationId <> "" And stationName <> "" Then
            If Not IsNumeric(ws.Cells(rowIndex, "C").Value) Or _
               Not IsNumeric(ws.Cells(rowIndex, "D").Value) Then
                ws.Range("A" & rowIndex & ":D" & rowIndex).Interior.Color = RGB(254, 202, 202)
                mismatches(stationName) = True
            Else
                latitude = CDbl(ws.Cells(rowIndex, "C").Value)
                longitude = CDbl(ws.Cells(rowIndex, "D").Value)

                If counts.Exists(stationName) Then
                    counts(stationName) = CLng(counts(stationName)) + 1
                Else
                    counts(stationName) = 1
                End If

                If Not info.Exists(stationName) Then
                    info(stationName) = Array(latitude, longitude, stationId, rowIndex)
                Else
                    firstValue = info(stationName)
                    If Abs(latitude - CDbl(firstValue(0))) > COORD_TOLERANCE Or _
                       Abs(longitude - CDbl(firstValue(1))) > COORD_TOLERANCE Then
                        mismatches(stationName) = True
                    End If
                End If
            End If
        End If
    Next rowIndex

    For rowIndex = 2 To lastRow
        stationName = NormalizeStationName(ws.Cells(rowIndex, "B").Value)
        If stationName <> "" And counts.Exists(stationName) Then
            If CLng(counts(stationName)) > 1 Then
                transferRowCount = transferRowCount + 1
                If mismatches.Exists(stationName) Then
                    ws.Range("A" & rowIndex & ":D" & rowIndex).Interior.Color = RGB(254, 202, 202)
                Else
                    ws.Range("A" & rowIndex & ":D" & rowIndex).Interior.Color = RGB(220, 252, 231)
                End If
            End If
        End If
    Next rowIndex

    mismatchCount = mismatches.Count

    If mismatchCount = 0 Then
        MsgBox "Validation passed. Duplicate station names use consistent coordinates." & vbCrLf & _
               "Transfer-station rows checked: " & transferRowCount, vbInformation
    Else
        MsgBox "Validation failed. " & mismatchCount & _
               " duplicated station name(s) have inconsistent coordinates." & vbCrLf & _
               "Rows in red need correction.", vbCritical
    End If
End Sub
